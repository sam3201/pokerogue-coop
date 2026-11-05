/**
 * SAM/JevBot local capture policy. It proposes Poké Ball actions only from a
 * fresh game-state observation and uses ordinary game input for the request.
 * A throw is NOT evidence of a catch. Co-op partner arbitration remains
 * authoritative. This module never writes dex ownership or grants Pokémon.
 */
const SEATS = new Set(["host", "guest"]);
const WILD_BATTLE = 0; // src/enums/battle-type.ts: BattleType.WILD
const MAX_BALL_TIER = 3; // Never spend a Master Ball automatically

function nonnegativeInt(x) { return Number.isSafeInteger(x) && x >= 0; }
function positiveInt(x) { return Number.isSafeInteger(x) && x > 0; }
function numberIn(x, lo, hi) {
  return typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
}
function parseCaughtAttr(x) {
  if (typeof x === "bigint") return x > 0n;
  if (typeof x === "number") return Number.isSafeInteger(x) && x > 0;
  return typeof x === "string" && /^[0-9]{1,80}$/.test(x) && BigInt(x) > 0n;
}
export function validateCaptureSnapshot(s) {
  if (!s || s.source !== "loaded-game-battle" || !SEATS.has(s.seat)
    || s.ui !== "COMMAND" || !positiveInt(s.wave)
    || !nonnegativeInt(s.turn) || !nonnegativeInt(s.battleType)
    || !Array.isArray(s.enemies) || s.enemies.length > 2
    || !Array.isArray(s.ballCounts) || s.ballCounts.length < 5
    || s.ballCounts.some(x => !nonnegativeInt(x))
    || typeof s.specialBattle !== "boolean"
    || typeof s.isChallenge !== "boolean") {
    throw new Error("invalid or stale capture snapshot");
  }
  for (const e of s.enemies) {
    if (!e || !positiveInt(e.speciesId) || !numberIn(e.hp, 0, 1000000)
      || !numberIn(e.maxHp, 1, 1000000) || e.hp > e.maxHp
      || !numberIn(e.catchRate, 0, 255) || typeof e.boss !== "boolean"
      || !["string", "number", "bigint"].includes(typeof e.caughtAttr)
      || (typeof e.caughtAttr === "string" && !/^[0-9]{1,80}$/.test(e.caughtAttr)))
      throw new Error("invalid enemy/dex evidence");
  }
  return s;
}
export function proposeCapture(snapshot, opts = {}) {
  const s = validateCaptureSnapshot(snapshot);
  if (opts.alreadyAttempted === true) return {kind:"fight", reason:"encounter-already-probed"};
  if (s.battleType !== WILD_BATTLE || s.specialBattle || s.isChallenge)
    return {kind:"fight", reason:"nonstandard-or-restricted-battle"};
  if (s.enemies.length !== 1 || s.enemies[0].hp <= 0)
    return {kind:"fight", reason:"no-single-active-enemy"};
  const target = s.enemies[0];
  if (target.boss) return {kind:"fight", reason:"boss-catching-requires-game-validation"};
  if (parseCaughtAttr(target.caughtAttr))
    return {kind:"fight", reason:"species-already-unlocked"};
  const hpRatio = target.hp / target.maxHp;
  if (hpRatio > 0.55) return {kind:"fight", reason:"target-not-weakened-enough"};
  // Avoid rare or costly high-tier balls unless a weaker species cannot be
  // captured reliably. This is a conservative heuristic, not catch odds.
  let preferred = 0;
  if (target.catchRate < 90 || hpRatio > 0.35) preferred = 1;
  if (target.catchRate < 40 && hpRatio > 0.25) preferred = 2;
  let selected = -1;
  for (const type of [preferred, ...[0,1,2,3]]) {
    if (type <= MAX_BALL_TIER && s.ballCounts[type] > 0) {selected=type; break;}
  }
  if (selected < 0) return {kind:"fight", reason:"no-allowed-ball-in-inventory"};
  return {
    kind:"propose-capture",
    ballType:selected, speciesId:target.speciesId, wave:s.wave, turn:s.turn,
    seat:s.seat, reason:"unlocked-species-unknown-exploration",
    verifiedCatch:false, estimateType:"heuristic-not-catch-probability",
    uncertaintyReductionTarget:"verify-new-species-ownership-after-game-capture",
  };
}

export async function readCaptureSnapshot(client, seat) {
  if (!SEATS.has(seat)) throw new Error("invalid co-op seat");
  return client.page.evaluate(async mySeat => {
    if (window.__coop?.ui !== "COMMAND") return null;
    const {globalScene} = await import(/* @vite-ignore */ "/src/globals/global-scene.ts");
    const battle = globalScene.currentBattle;
    const gameData = globalScene.gameData;
    if (!battle || !gameData || !globalScene.pokeballCounts) return null;
    const phase = window.__coop?.phase;
    const enemies = globalScene.getEnemyField().filter(p => p.isActive(true)).map(p => ({
      speciesId:Number(p.species.speciesId),
      hp:Number(p.hp), maxHp:Number(p.getMaxHp()),
      catchRate:Number(p.species.catchRate),
      boss:Boolean(p.isBoss?.()),
      caughtAttr:String(gameData.dexData?.[p.species.speciesId]?.caughtAttr ?? 0n),
    }));
    return {
      source:"loaded-game-battle",seat:mySeat,ui:"COMMAND",
      wave:Number(battle.waveIndex),turn:Number(phase?.turn ?? 0),
      battleType:Number(battle.battleType),
      specialBattle:Boolean(battle.isBattleMysteryEncounter?.()
        || globalScene.gameMode.isBattleClassicFinalBoss?.(battle.waveIndex)
        || globalScene.arena?.biomeId === 21 /* conservative End biome check below */),
      isChallenge:Boolean(globalScene.gameMode.hasAnyChallenges?.()),
      enemies,ballCounts:[0,1,2,3,4].map(x=>Number(globalScene.pokeballCounts[x]??0)),
    };
  }, seat);
}

async function currentCursor(client) {
  return client.page.evaluate(async()=>{
    const {globalScene}=await import(/* @vite-ignore */ "/src/globals/global-scene.ts");
    if(window.__coop?.ui==="COMMAND")return globalScene.ui.getHandler().getCursor();
    if(window.__coop?.ui==="BALL")return globalScene.ui.getHandler().getCursor();
    throw new Error("not on supported capture menu");
  });
}

async function guardedButton(client, expectedUi, button) {
  const accepted=await client.page.evaluate(([mode,b])=>{
    if(window.__coop?.ui!==mode) return false;
    return window.__coop.press(b);
  },[expectedUi,button]);
  if(!accepted)throw new Error("game did not accept "+button+" in "+expectedUi);
}

/**
 * Make the ball selection with game buttons. Does not assert successful catch.
 * No move is sent if the evidence becomes stale before opening BALL menu.
 * Caller must coordinate with the partner's normal co-op arbitration.
 */
export async function requestCapture(client, seat, proposal) {
  if(!proposal || proposal.kind!=="propose-capture" || proposal.seat!==seat
    || !positiveInt(proposal.speciesId) || !nonnegativeInt(proposal.ballType)
    || proposal.ballType>MAX_BALL_TIER) throw new Error("invalid capture proposal");
  const current=await readCaptureSnapshot(client,seat);
  if (!current || current.wave!==proposal.wave || current.turn!==proposal.turn)
    throw new Error("capture proposal expired");
  const refreshed=proposeCapture(current);
  if(refreshed.kind!=="propose-capture" || refreshed.speciesId!==proposal.speciesId)
    throw new Error("capture no longer eligible");
  let cursor=await currentCursor(client);
  // Command menu layout: [Fight(0),Ball(1)] / [Pokemon(2),Run(3)]
  const paths={0:["RIGHT"],1:[],2:["UP","RIGHT"],3:["UP"],4:["RIGHT","RIGHT"]};
  if(!Object.hasOwn(paths,cursor))throw new Error("unsupported command cursor");
  for(const button of paths[cursor]) await guardedButton(client,"COMMAND",button);
  if(await currentCursor(client)!==1)throw new Error("failed to target BALL menu");
  await guardedButton(client,"COMMAND","ACTION");
  if(await client.page.evaluate(()=>window.__coop?.ui)!=="BALL")
    throw new Error("BALL menu did not open");
  const updated=await readCaptureSnapshot(client,seat);
  // readCaptureSnapshot is only available on COMMAND. The pending decision
  // was already validated before opening BALL. Revalidate real inventory.
  const liveCounts=await client.page.evaluate(async()=>{
    const {globalScene}=await import(/* @vite-ignore */ "/src/globals/global-scene.ts");
    return [0,1,2,3,4].map(i=>Number(globalScene.pokeballCounts[i]??0));
  });
  if(liveCounts[proposal.ballType]<=0)throw new Error("proposed ball no longer owned");
  cursor=await currentCursor(client);
  if(!nonnegativeInt(cursor) || cursor>5)throw new Error("unexpected ball cursor");
  // BALL has 5 types then Cancel. Only 0..3 permitted.
  for(let i=0;i<6 && cursor!==proposal.ballType;i++){
    const btn=cursor>proposal.ballType ? "UP" : "DOWN";
    await guardedButton(client,"BALL",btn);
    cursor=await currentCursor(client);
  }
  if(cursor!==proposal.ballType)throw new Error("ball cursor never reached desired type");
  await guardedButton(client,"BALL","ACTION");
  return {
    requested:true,gameAcceptedInput:true,
    seat,speciesId:proposal.speciesId,ballType:proposal.ballType,
    verifiedCatch:false,verifiedDexUnlock:false,
    provenance:"game-button-request-not-catch-proof",
  };
}

export function observeCaptureOutcome(before, after, {saveConfirmed=false}={}) {
  validateCaptureSnapshot(before);
  if (!after || after.source!=="loaded-game-dex"
    || after.seat!==before.seat || !Array.isArray(after.entries))
    throw new Error("no authoritative post-capture dex evidence");
  const target=before.enemies[0];
  if(!target)throw new Error("capture had no target");
  const updated=after.entries.find(e=>e.speciesId===target.speciesId);
  const newlyCaught=!parseCaughtAttr(target.caughtAttr)
    && updated && parseCaughtAttr(updated.caughtAttr)
    && Number.isSafeInteger(updated.caughtCount)
    && updated.caughtCount>0;
  return {
    speciesId:target.speciesId,newlyUnlocked:Boolean(newlyCaught),
    eligibleAfterConfirmedSave:Boolean(newlyCaught && saveConfirmed),
    source:"observed-dex-transition", // no invented completion
  };
}
