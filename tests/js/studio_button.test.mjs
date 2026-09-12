import test from "node:test";
import assert from "node:assert/strict";
import { attachStudioButton, needsStudioButton } from "../../js/abc_studio/button.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
function fixture() {
  const source = { widgets: [{ name: "abc", type: "customtext", value: "SOURCE" }] };
  const graph = { links: { 8: { origin_id: 12 } }, getNodeById: () => source };
  let calls = 0;
  const node = {
    inputs: [{ name: "abc", link: null }],
    widgets: [{ name: "abc", type: "customtext", value: "OWN" }],
    size: [600, 800],
    addWidget(type, name, value, callback) {
      const widget = { type, name, value, callback }; this.widgets.push(widget); return widget;
    },
    computeSize: () => [300, 200],
    setSize(size) { this.size = size; },
    onConnectionsChange(...args) { calls++; assert.equal(this, node); return args[0]; },
  };
  return { source, graph, node, calls: () => calls };
}
const buttons = (node) => node.widgets.filter((w) => w.type === "button");

test("one editor per connected ABC source; plain text keeps its shortcut", () => {
  const { source, graph, node } = fixture();
  assert.equal(needsStudioButton(node, graph), true);
  node.inputs[0].link = 8;
  assert.equal(needsStudioButton(node, graph), false);
  source.mode = 4;
  assert.equal(needsStudioButton(node, graph), false);
  source.widgets[0].name = "value";
  assert.equal(needsStudioButton(node, graph), true);
  assert.equal(needsStudioButton({ widgets: [] }, graph), false);
});

test("connect, disconnect, restore and repeated hooks preserve ABC and callbacks", async () => {
  const { graph, node, calls } = fixture();
  let opened = 0;
  const attach = () => attachStudioButton(node, () => graph, () => opened++);
  attach(); attach(); await tick();
  assert.equal(buttons(node).length, 1);
  assert.equal(buttons(node)[0].serialize, false);
  buttons(node)[0].callback();
  assert.equal(opened, 1);
  assert.deepEqual(node.size, [600, 800]);
  for (let i = 0; i < 3; i++) {
    // Callback before link mutation, as happens during loading/connect.
    assert.equal(node.onConnectionsChange(1), 1);
    node.inputs[0].link = 8;
    await tick();
    assert.equal(buttons(node).length, 0);
    node.inputs[0].link = null;
    node.onConnectionsChange(1);
    await tick();
    assert.equal(buttons(node).length, 1);
  }
  node.inputs[0].link = 8;
  node.onConfigure({}); attach(); await tick();
  assert.equal(buttons(node).length, 0);
  assert.equal(node.widgets[0].value, "OWN");
  assert.equal(calls(), 6);
});

test("loading an already linked node never adds a duplicate button", async () => {
  const { graph, node } = fixture();
  node.inputs[0].link = 8;
  attachStudioButton(node, () => graph, () => {});
  await tick();
  assert.equal(buttons(node).length, 0);
  node.inputs[0].link = null;
  node.onConnectionsChange(1);
  await tick();
  assert.equal(buttons(node).length, 1);
});
