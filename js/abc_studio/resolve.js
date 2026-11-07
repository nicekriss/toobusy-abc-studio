// abc 악보가 실제로 읽히는 자리를 찾는다.
//
// ComfyUI 에서 텍스트 위젯은 입력 소켓으로 바꿀 수 있고, 소켓에 선이 꽂히면
// 노드 자신의 위젯 값은 무시되고 연결된 노드의 출력이 쓰인다. 그래서 버튼이
// 노드 위젯에만 값을 넣으면 선이 꽂혀 있을 때 조용히 묻힌다. 선을 따라가
// 근원 노드의 텍스트 위젯에 넣어야 실제로 생성에 반영된다.
//
// 선은 여러 번 이어질 수 있다(A → B → C). 근원 노드의 텍스트 칸에도 선이
// 꽂혀 있으면 그 칸도 무시되므로 끝까지 따라간다.
//
// 근원 노드에서 "어느 칸이 그대로 출력이 되는지"를 확신할 수 없으면 쓰지 않는다.
// 칸 이름만 보고 고르면 표시 전용 칸(Show Any 류)이나 구분자 같은 설정값을
// 악보로 덮어쓰고도 "적용됨"이라고 하게 된다.
//
// 그래서 칸 값을 0번 출력으로 그대로 내보낸다고 확실히 아는 노드(아래 목록)만
// 인정한다. 그 밖의 노드는 칸 이름이 그럴듯해도 거부하고, 선을 빼거나
// 'ABC 악보 입력' 노드로 이으라고 안내한다.
const PASSTHROUGH_TYPES = {
  PrimitiveNode: ["value"],
  PrimitiveString: ["value"],
  PrimitiveStringMultiline: ["value"],
  ABCScoreInput: ["abc"],
};
const TEXT_WIDGET_TYPES = ["customtext", "text", "string"];
const MAX_HOPS = 16;

function isTextWidget(w) {
  if (!w || typeof w.value !== "string") return false;
  // 선택 목록(콤보)·변환된 위젯 등은 type 이 제각각이라 허용 목록으로만 받는다
  const type = w.type === "converted-widget" ? w.origType : w.type;
  if (!TEXT_WIDGET_TYPES.includes(type)) return false;
  // 표시 전용 칸: 저장되지 않거나 읽기 전용
  if (w.serialize === false) return false;
  if (w.options && (w.options.serialize === false || w.options.readonly || w.options.read_only)) return false;
  if (w.inputEl && w.inputEl.readOnly) return false;
  if (w.element && w.element.readOnly) return false;
  return true;
}

// origin_slot 으로 나가는 값이 어느 칸인지 확정되면 그 칸을, 아니면 null.
function textWidgetOf(node, originSlot = 0) {
  if (!node || !node.widgets) return null;
  const usable = node.widgets.filter(isTextWidget);
  const known = PASSTHROUGH_TYPES[node.type];
  if (!known || originSlot !== 0) return null;
  for (const name of known) {
    const hit = usable.find((w) => w.name === name);
    if (hit) return hit;
  }
  return null;
}

// 꺼진 노드(mute 2, bypass 4)의 출력은 생성 노드에 닿지 않는다.
function isDisabled(node) {
  return !!node && node.mode !== 0 && node.mode !== undefined;
}

// 위젯이 입력 소켓으로 바뀌어 있으면 그 소켓을 돌려준다.
function inputForWidget(node, name) {
  return (node.inputs || []).find(
    (i) => i && (i.name === name || (i.widget && i.widget.name === name))
  ) || null;
}

function linkedSource(input, graph) {
  if (!input || input.link == null) return { linked: false, source: null, slot: 0 };
  const links = graph ? graph.links : null;
  const link = links ? (typeof links.get === "function" ? links.get(input.link) : links[input.link]) : null;
  const source = link && graph.getNodeById ? graph.getNodeById(link.origin_id) : null;
  // 출력 번호가 없거나 숫자가 아니면 어느 출력인지 모르는 것이므로 -1(거부)로 둔다
  const slot = link && Number.isInteger(link.origin_slot) ? link.origin_slot : -1;
  return { linked: true, source, slot };
}

function resolveAbcTarget(node, graph) {
  if (!node) return null;
  const start = inputForWidget(node, "abc");
  const first = linkedSource(start, graph);
  if (!first.linked) {
    const own = (node.widgets || []).find(
      (w) => w && w.name === "abc" && w.type !== "button"
    );
    if (!own) return null;
    // 자기 칸도 같은 보호를 거친다: 콤보·표시 전용·읽기 전용이면 쓰지 않는다
    if (!isTextWidget(own)) {
      return { node: node, widget: null, viaLink: false, disabled: false, disabledNode: null, reason: "own-widget-not-text" };
    }
    return { node: node, widget: own, viaLink: false, disabled: false, disabledNode: null, reason: null };
  }

  // 경로 중 처음 만난 꺼진 노드. 안내 문구에서 "어느 노드를 켜야 하는지"에 쓴다
  let disabledNode = null;
  let current = first.source;
  let slot = first.slot;
  // id 가 없는 노드(테스트 대역 등)도 있으므로 노드 객체 자체로 순환을 판단한다
  const seen = new Set([node]);
  const fail = (reason, at) => ({
    node: at || null, widget: null, viaLink: true,
    disabled: !!disabledNode, disabledNode, reason,
  });
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (!current) return fail("link-source-missing");
    if (seen.has(current)) return fail("link-cycle");
    seen.add(current);
    if (!disabledNode && isDisabled(current)) disabledNode = current;

    // 리루트는 칸이 없고 입력을 그대로 넘긴다
    if (current.type === "Reroute") {
      // 리루트는 출력이 하나(0번)뿐이다. 다른 번호에서 온 선은 정상 연결이 아니다
      if (slot !== 0) return fail("linked-node-has-no-text-box", current);
      const next = linkedSource((current.inputs || [])[0], graph);
      if (!next.linked) return fail("linked-node-has-no-text-box", current);
      current = next.source;
      slot = next.slot;
      continue;
    }

    const widget = textWidgetOf(current, slot);
    if (!widget) return fail("linked-node-has-no-text-box", current);
    const next = linkedSource(inputForWidget(current, widget.name), graph);
    if (!next.linked) {
      return { node: current, widget, viaLink: true, disabled: !!disabledNode, disabledNode, reason: null };
    }
    current = next.source;
    slot = next.slot;
  }
  return fail("link-too-deep");
}

export { resolveAbcTarget, textWidgetOf, isDisabled };
