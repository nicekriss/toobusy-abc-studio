import { resolveAbcTarget } from "./resolve.js";

export function hasAbcSlot(node) {
  return (node.widgets || []).some((w) => w && w.name === "abc" && w.type !== "button")
    || (node.inputs || []).some((i) => i && i.name === "abc");
}

// The upstream ABC editor owns the score. Keep a shortcut here only when that
// source has no editor of its own (for example a plain STRING primitive).
export function needsStudioButton(node, graph) {
  if (!hasAbcSlot(node)) return false;
  const target = resolveAbcTarget(node, graph);
  return !(target?.viaLink && target.node && hasAbcSlot(target.node));
}

const states = new WeakMap();

export function attachStudioButton(node, getGraph, open) {
  if (!hasAbcSlot(node)) return;
  let state = states.get(node);
  if (state) { state.schedule(); return; }
  state = { button: null, pending: false };
  const sync = () => {
    const show = needsStudioButton(node, getGraph());
    if (show === !!state.button) return;
    if (show) {
      state.button = node.addWidget("button", "🎼 악보 스튜디오 열기", null, open);
      state.button.serialize = false;
      state.button.options = {...state.button.options, serialize: false};
      // Never shrink a node the user has resized.
      const size = node.computeSize();
      node.setSize([Math.max(node.size[0], size[0]), Math.max(node.size[1], size[1])]);
    } else {
      const index = node.widgets.indexOf(state.button);
      if (index >= 0) node.widgets.splice(index, 1);
      state.button = null;
    }
    node.setDirtyCanvas?.(true, true);
  };
  state.schedule = () => {
    if (state.pending) return;
    state.pending = true;
    // Graph loading and connection callbacks can run before links are final.
    setTimeout(() => { state.pending = false; sync(); }, 0);
  };
  states.set(node, state);
  for (const name of ["onConnectionsChange", "onConfigure"]) {
    const original = node[name];
    node[name] = function (...args) {
      try { return original?.apply(this, args); }
      finally { state.schedule(); }
    };
  }
  state.schedule();
}
