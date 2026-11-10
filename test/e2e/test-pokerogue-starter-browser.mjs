import assert from "node:assert/strict";
import test from "node:test";
import {starterReadyTransitionObserved} from "./pokerogue-starter-browser.mjs";

test("accepts confirmed starter screen without requiring a transient frame", () => {
  assert.equal(starterReadyTransitionObserved({ui:"STARTER_SELECT",wave:0}),true);
  assert.equal(starterReadyTransitionObserved({ui:"STARTER_SELECT",wave:1}),true);
});

test("recognizes authentic battle entry after co-op ready confirmation", () => {
  for(const ui of ["COMMAND","FIGHT","TARGET_SELECT"])
    assert.equal(starterReadyTransitionObserved({ui,wave:1}),true);
});

test("never mistakes a pregame confirmation or message for completed readiness", () => {
  for(const ui of ["CONFIRM","TITLE","MESSAGE","OPTION_SELECT","COOP_JOIN_FORM"])
    assert.equal(starterReadyTransitionObserved({ui,wave:1}),false);
  assert.equal(starterReadyTransitionObserved({ui:"COMMAND",wave:0}),false);
  assert.equal(starterReadyTransitionObserved({ui:"COMMAND",wave:NaN}),false);
  assert.equal(starterReadyTransitionObserved(null),false);
});

test("fails closed on missing or malformed state", () => {
  assert.equal(starterReadyTransitionObserved({}),false);
  assert.equal(starterReadyTransitionObserved({ui:"COMMAND"}),false);
  assert.equal(starterReadyTransitionObserved({ui:"COMMAND",wave:"1"}),false);
  assert.equal(starterReadyTransitionObserved({ui:"FIGHT",wave:-1}),false);
});
