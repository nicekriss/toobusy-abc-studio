// abc 칸이 입력 소켓으로 바뀌고 선이 꽂혔을 때, 악보가 실제로 읽히는 자리를
// 찾아내는지 본다. 이걸 틀리면 스튜디오가 쓴 악보가 조용히 묻힌다.
import { resolveAbcTarget } from "../../js/abc_studio/resolve.js";

const graph = {
  links: { 8: { origin_id: 12, origin_slot: 0 } },
  nodes: {},
  getNodeById(id) { return this.nodes[id] || null; },
};
const primitive = { id: 12, type: "PrimitiveNode", mode: 0, outputs: [{ name: "STRING" }],
  widgets: [{ name: "value", type: "customtext", value: "OLD" }] };
graph.nodes[12] = primitive;

const linked = {
  id: 3,
  inputs: [{ name: "model" }, { name: "style" }, { name: "lyrics" }, { name: "abc", link: 8 }],
  widgets: [{ name: "seed", type: "number", value: 1 }, { name: "abc", type: "customtext", value: "IGNORED" }],
};
const plain = {
  id: 4,
  inputs: [{ name: "model" }],
  widgets: [{ name: "abc", type: "customtext", value: "MINE" }],
};
const unlinkedSocket = {
  id: 5,
  inputs: [{ name: "abc", link: null }],
  widgets: [{ name: "abc", type: "customtext", value: "MINE" }],
};

let fails = 0;
const check = (label, cond) => { if (!cond) { console.log("FAIL " + label); fails++; } else console.log("ok " + label); };

let t = resolveAbcTarget(linked, graph);
check("선이 꽂히면 근원 노드를 가리킨다", t.node === primitive && t.viaLink === true);
check("근원 노드의 텍스트 위젯을 찾는다", t.widget === primitive.widgets[0]);
check("켜져 있으면 disabled 아님", t.disabled === false);

primitive.mode = 4;
t = resolveAbcTarget(linked, graph);
check("꺼진 근원 노드를 알아챈다", t.disabled === true);
primitive.mode = 0;

t = resolveAbcTarget(plain, graph);
check("선이 없으면 자기 위젯", t.node === plain && t.widget === plain.widgets[0] && t.viaLink === false);

t = resolveAbcTarget(unlinkedSocket, graph);
check("소켓만 있고 선이 없으면 자기 위젯", t.node === unlinkedSocket && t.viaLink === false);

graph.nodes[12] = { id: 12, mode: 0, widgets: [{ name: "image", type: "combo", value: 3 }] };
t = resolveAbcTarget(linked, graph);
check("텍스트 칸 없는 노드가 꽂히면 이유를 준다", t.widget === null && t.reason === "linked-node-has-no-text-box");

check("abc 가 아예 없으면 null", resolveAbcTarget({ id: 9, widgets: [] }, graph) === null);

// --- 여러 번 이어진 선: A(악보 입력) → B(악보 입력) → C(악보 정보) ---
// B 의 abc 칸에도 선이 꽂혀 있으면 B 의 값은 무시된다. A 까지 가야 한다.
const g2 = { links: {}, nodes: {}, getNodeById(id) { return this.nodes[id] || null; } };
const A = { id: 21, type: "ABCScoreInput", mode: 0, inputs: [{ name: "abc", widget: { name: "abc" }, link: null }],
  widgets: [{ name: "abc", type: "customtext", value: "A" }] };
const B = { id: 22, type: "ABCScoreInput", mode: 0, inputs: [{ name: "abc", widget: { name: "abc" }, link: 31 }],
  widgets: [{ name: "abc", type: "customtext", value: "B-IGNORED" }] };
const C = { id: 23, type: "ABCScoreInfo", inputs: [{ name: "abc", link: 32 }], widgets: [] };
g2.nodes = { 21: A, 22: B, 23: C };
g2.links = { 31: { origin_id: 21, origin_slot: 0 }, 32: { origin_id: 22, origin_slot: 0 } };
t = resolveAbcTarget(C, g2);
check("두 단계 연결이면 맨 앞 근원(A)까지 간다", t.node === A && t.widget === A.widgets[0] && t.viaLink === true);

B.mode = 4;
t = resolveAbcTarget(C, g2);
check("중간 노드가 꺼져 있어도 알아챈다", t.node === A && t.disabled === true);
check("꺼진 노드가 근원이 아니라 중간(B)임을 알려 준다", t.disabledNode === B);
B.mode = 0;
t = resolveAbcTarget(C, g2);
check("다 켜져 있으면 disabledNode 없음", t.disabled === false && t.disabledNode === null);

// 새 프런트엔드는 graph.links 가 Map 이다
const g2map = { links: new Map(Object.entries(g2.links).map(([k, v]) => [Number(k), v])), getNodeById: (id) => g2.nodes[id] || null };
t = resolveAbcTarget(C, g2map);
check("links 가 Map 이어도 따라간다", t.node === A);

// 위젯 이름과 소켓 이름이 다른 경우(widget.name 으로만 이어짐)도 따라간다
B.inputs = [{ name: "abc_in", widget: { name: "abc" }, link: 31 }];
t = resolveAbcTarget(C, g2);
check("widget.name 으로 바뀐 소켓도 따라간다", t.node === A);

// 리루트를 거쳐도 근원까지 간다
const R = { id: 24, type: "Reroute", mode: 0, inputs: [{ name: "", link: 33 }], widgets: [] };
g2.nodes[24] = R;
g2.links[33] = { origin_id: 21, origin_slot: 0 };
g2.links[32] = { origin_id: 24, origin_slot: 0 };
t = resolveAbcTarget(C, g2);
check("리루트를 지나 근원까지 간다", t.node === A && t.widget === A.widgets[0]);

// 선이 빙 돌면 멈추고 이유를 준다
g2.links[32] = { origin_id: 22, origin_slot: 0 };
g2.links[31] = { origin_id: 22, origin_slot: 0 };
t = resolveAbcTarget(C, g2);
check("순환 연결이면 쓰지 않고 이유를 준다", t.node === null && t.widget === null && t.reason === "link-cycle");

// 너무 길게 이어진 선(순환은 아님)은 끝까지 가지 않고 멈춘다
const g4 = { links: {}, nodes: {}, getNodeById(id) { return this.nodes[id] || null; } };
const chainLen = 20;
for (let i = 0; i < chainLen; i++) {
  const id = 100 + i;
  const linkId = 200 + i;
  g4.nodes[id] = { id, type: "ABCScoreInput", mode: 0, outputs: [{ name: "abc" }],
    inputs: [{ name: "abc", link: i < chainLen - 1 ? linkId : null }],
    widgets: [{ name: "abc", type: "customtext", value: "N" + i }] };
  if (i < chainLen - 1) g4.links[linkId] = { origin_id: id + 1, origin_slot: 0 };
}
const tail = { id: 99, inputs: [{ name: "abc", link: 199 }], widgets: [] };
g4.links[199] = { origin_id: 100, origin_slot: 0 };
t = resolveAbcTarget(tail, g4);
check("너무 긴 연결은 멈추고 이유를 준다", t.node === null && t.reason === "link-too-deep");
// 짧은 연결(5단)은 끝까지 간다
g4.nodes[104].inputs[0].link = null;
t = resolveAbcTarget(tail, g4);
check("5단 연결은 끝(근원)까지 간다", t.node === g4.nodes[104] && t.reason === null);

// --- 출력과 관계가 확인되지 않는 칸은 쓰지 않는다 ---
const g3 = { links: { 41: { origin_id: 51, origin_slot: 0 } }, nodes: {}, getNodeById(id) { return this.nodes[id] || null; } };
const target = { id: 50, inputs: [{ name: "abc", link: 41 }], widgets: [] };
// 아래 거부 검사는 전부 허용 노드(프리미티브·ABC 악보 입력)에서 한다.
// 허용 목록 밖 노드로 시험하면 노드 종류 검사에서 먼저 걸러져, 정작 보려는
// 보호(이름 검사·콤보 검사)를 지워도 테스트가 통과해 버린다.

// KJNodes JoinStrings 형태: 문자열 칸은 delimiter 하나 → 허용 노드 종류라도 이름이 안 맞으면 거부
g3.nodes[51] = { id: 51, type: "PrimitiveStringMultiline", mode: 0, outputs: [{ name: "STRING" }],
  widgets: [{ name: "delimiter", type: "text", value: " " }] };
t = resolveAbcTarget(target, g3);
check("허용 노드라도 칸 이름이 안 맞으면 고르지 않는다", t.widget === null && t.reason === "linked-node-has-no-text-box");

// 이름 안 맞는 칸이 앞에 있어도 이름 맞는 칸을 고른다
g3.nodes[51].widgets = [{ name: "delimiter", type: "text", value: " " }, { name: "value", type: "customtext", value: "V" }];
t = resolveAbcTarget(target, g3);
check("이름 맞는 칸을 고르고 앞의 다른 칸은 건너뛴다", t.widget === g3.nodes[51].widgets[1]);

g3.nodes[51] = { id: 51, type: "ABCScoreInput", mode: 0, outputs: [{ name: "abc" }],
  widgets: [{ name: "abc", type: "combo", value: "preset_a" }] };
t = resolveAbcTarget(target, g3);
check("허용 노드라도 일반 콤보는 고르지 않는다", t.widget === null);

g3.nodes[51] = { id: 51, type: "PrimitiveNode", mode: 0, outputs: [{ name: "STRING" }],
  widgets: [{ name: "value", type: "customselect", value: "x", options: { values: ["x", "y"] } }] };
t = resolveAbcTarget(target, g3);
check("허용 노드라도 사용자 정의 선택 칸은 고르지 않는다", t.widget === null);

// 문자열이 아닌 값을 가진 칸(숫자 등)은 type 이 text 여도 고르지 않는다
g3.nodes[51] = { id: 51, type: "PrimitiveNode", mode: 0, outputs: [{ name: "INT" }],
  widgets: [{ name: "value", type: "text", value: 5 }] };
t = resolveAbcTarget(target, g3);
check("값이 문자열이 아닌 칸은 고르지 않는다", t.widget === null);

// 두 번째 단계에서 0번 아닌 출력으로 이어진 경우도 거부한다(단계마다 출력 번호를 다시 본다)
const g5 = { links: {}, nodes: {}, getNodeById(id) { return this.nodes[id] || null; } };
g5.nodes[61] = { id: 61, type: "PrimitiveNode", mode: 0, outputs: [{ name: "STRING" }, { name: "OTHER" }],
  widgets: [{ name: "value", type: "customtext", value: "P" }] };
g5.nodes[62] = { id: 62, type: "ABCScoreInput", mode: 0, outputs: [{ name: "abc" }],
  inputs: [{ name: "abc", widget: { name: "abc" }, link: 71 }], widgets: [{ name: "abc", type: "customtext", value: "B" }] };
const t5 = { id: 63, inputs: [{ name: "abc", link: 72 }], widgets: [] };
g5.links[71] = { origin_id: 61, origin_slot: 1 };
g5.links[72] = { origin_id: 62, origin_slot: 0 };
t = resolveAbcTarget(t5, g5);
check("두 번째 단계의 0번 아닌 출력도 거부한다", t.widget === null && t.node === g5.nodes[61]);
g5.links[71].origin_slot = 0;
t = resolveAbcTarget(t5, g5);
check("두 번째 단계가 0번 출력이면 근원까지 간다", t.widget === g5.nodes[61].widgets[0]);

// 꺼진 노드가 여럿이면 생성 노드에서 가장 가까운(먼저 만나는) 노드를 알려 준다
g5.nodes[62].mode = 2;
g5.nodes[61].mode = 4;
t = resolveAbcTarget(t5, g5);
check("꺼진 노드가 여럿이면 먼저 만나는 노드를 짚는다", t.disabledNode === g5.nodes[62]);

// 리루트를 지날 때도 출력 번호를 이어받는다: 프리미티브 1번 출력 → 리루트 → abc 는 거부
g5.nodes[64] = { id: 64, type: "Reroute", mode: 0, inputs: [{ name: "", link: 73 }], widgets: [] };
g5.nodes[61].mode = 0; g5.nodes[62].mode = 0;
g5.links[73] = { origin_id: 61, origin_slot: 1 };
const t6 = { id: 65, inputs: [{ name: "abc", link: 74 }], widgets: [] };
g5.links[74] = { origin_id: 64, origin_slot: 0 };
t = resolveAbcTarget(t6, g5);
check("리루트 너머의 0번 아닌 출력도 거부한다", t.widget === null && t.node === g5.nodes[61]);
g5.links[73].origin_slot = 0;
t = resolveAbcTarget(t6, g5);
check("리루트 너머의 0번 출력이면 쓴다", t.widget === g5.nodes[61].widgets[0]);

// 중간 노드의 칸이 '변환된 위젯'(converted-widget, 원래 customtext)이어도 그 칸의 선을 따라간다
const g6 = { links: {}, nodes: {}, getNodeById(id) { return this.nodes[id] || null; } };
g6.nodes[81] = { id: 81, type: "ABCScoreInput", mode: 0, outputs: [{ name: "abc" }],
  inputs: [{ name: "abc", widget: { name: "abc" }, link: null }], widgets: [{ name: "abc", type: "customtext", value: "A" }] };
g6.nodes[82] = { id: 82, type: "ABCScoreInput", mode: 0, outputs: [{ name: "abc" }],
  inputs: [{ name: "abc", widget: { name: "abc" }, link: 91 }],
  widgets: [{ name: "abc", type: "converted-widget", origType: "customtext", value: "B" }] };
const t7 = { id: 83, inputs: [{ name: "abc", link: 92 }], widgets: [] };
g6.links[91] = { origin_id: 81, origin_slot: 0 };
g6.links[92] = { origin_id: 82, origin_slot: 0 };
t = resolveAbcTarget(t7, g6);
check("변환된 텍스트 위젯을 지나 근원까지 간다", t.node === g6.nodes[81] && t.widget === g6.nodes[81].widgets[0]);

// --- 선이 없을 때 자기 abc 칸도 같은 보호를 거친다 ---
const ownCases = [
  ["콤보", { type: "combo" }],
  ["사용자 정의 선택", { type: "customselect", options: { values: ["a"] } }],
  ["serialize:false", { serialize: false }],
  ["options.serialize:false", { options: { serialize: false } }],
  ["options.readonly", { options: { readonly: true } }],
  ["options.read_only", { options: { read_only: true } }],
  ["inputEl.readOnly", { inputEl: { readOnly: true } }],
  ["element.readOnly", { element: { readOnly: true } }],
];
for (const [label, extra] of ownCases) {
  const self = { id: 70, inputs: [{ name: "abc", link: null }],
    widgets: [Object.assign({ name: "abc", type: "customtext", value: "MINE" }, extra)] };
  t = resolveAbcTarget(self, g3);
  check("선 없는 자기 칸이 " + label + " 이면 쓰지 않는다", t.widget === null && t.reason === "own-widget-not-text");
}

// 비정상 링크: 리루트 자신의 출력 번호가 0이 아니면 거부
g5.links[73].origin_slot = 0;
for (const bad of [1, -1]) {
  g5.links[74] = { origin_id: 64, origin_slot: bad };
  t = resolveAbcTarget(t6, g5);
  check("리루트의 출력 번호가 " + bad + " 이면 거부", t.widget === null && t.node === g5.nodes[64]);
}
g5.links[74] = { origin_id: 64, origin_slot: 0 };

// 비정상 링크: 출력 번호가 없거나 null 이면 0번으로 추정하지 않고 거부
const g7 = { links: {}, nodes: {}, getNodeById(id) { return this.nodes[id] || null; } };
g7.nodes[1] = { id: 1, type: "ABCScoreInput", mode: 0, outputs: [{ name: "abc" }],
  inputs: [{ name: "abc", widget: { name: "abc" }, link: null }], widgets: [{ name: "abc", type: "customtext", value: "A" }] };
const t8 = { id: 2, inputs: [{ name: "abc", link: 5 }], widgets: [] };
for (const [label, link] of [["없음", { origin_id: 1 }], ["null", { origin_id: 1, origin_slot: null }], ["문자열", { origin_id: 1, origin_slot: "0" }]]) {
  g7.links[5] = link;
  t = resolveAbcTarget(t8, g7);
  check("출력 번호가 " + label + " 인 링크는 거부", t.widget === null);
}
g7.links[5] = { origin_id: 1, origin_slot: 0 };
t = resolveAbcTarget(t8, g7);
check("출력 번호 0 이면 쓴다", t.widget === g7.nodes[1].widgets[0]);

// 허용 목록의 각 프리미티브 종류가 실제로 쓰인다
for (const type of ["PrimitiveNode", "PrimitiveString", "PrimitiveStringMultiline"]) {
  g7.nodes[1] = { id: 1, type, mode: 0, outputs: [{ name: "STRING" }], widgets: [{ name: "value", type: "text", value: "P" }] };
  t = resolveAbcTarget(t8, g7);
  check(type + " 은 근원으로 인정한다", t.widget === g7.nodes[1].widgets[0]);
}

// 자기 abc 칸의 값이 문자열이 아니면 쓰지 않는다
t = resolveAbcTarget({ id: 71, inputs: [], widgets: [{ name: "abc", type: "customtext", value: 3 }] }, g3);
check("자기 칸 값이 문자열이 아니면 쓰지 않는다", t.widget === null && t.reason === "own-widget-not-text");

// id 가 없는 노드끼리 이어져도 순환으로 오판하지 않는다
{
  const src = { type: "ABCScoreInput", mode: 0, outputs: [{ name: "abc" }], inputs: [{ name: "abc", link: null }],
    widgets: [{ name: "abc", type: "customtext", value: "S" }] };
  const gx = { links: { 1: { origin_id: "s", origin_slot: 0 } }, getNodeById: () => src };
  t = resolveAbcTarget({ inputs: [{ name: "abc", link: 1 }], widgets: [] }, gx);
  check("id 없는 노드도 순환으로 오판하지 않는다", t.node === src && t.widget === src.widgets[0]);
}

// 모르는 노드(JoinStrings)는 칸 이름이 무엇이든 거부
g3.nodes[51] = { id: 51, type: "JoinStrings", mode: 0, outputs: [{ name: "STRING" }],
  inputs: [{ name: "string1", link: 90 }, { name: "string2", link: 91 }],
  widgets: [{ name: "value", type: "text", value: " " }] };
t = resolveAbcTarget(target, g3);
check("모르는 노드는 이름 맞는 텍스트 칸이 있어도 거부", t.widget === null);

g3.nodes[51] = { id: 51, type: "PrimitiveStringMultiline", mode: 0, outputs: [{ name: "STRING" }],
  widgets: [{ name: "value", type: "customtext", value: "P" }] };
t = resolveAbcTarget(target, g3);
check("문자열 프리미티브는 그대로 쓴다", t.widget === g3.nodes[51].widgets[0]);

// 선택지를 함수로 주는 콤보, 변환된 콤보
g3.nodes[51] = { id: 51, type: "PrimitiveNode", mode: 0, outputs: [{ name: "STRING" }],
  widgets: [{ name: "value", type: "customselect", value: "preset_a", options: { values: () => ["preset_a", "preset_b"] } }] };
t = resolveAbcTarget(target, g3);
check("함수형 선택지 콤보는 고르지 않는다", t.widget === null);
g3.nodes[51].widgets = [{ name: "value", type: "converted-widget", origType: "combo", value: "preset_a" }];
t = resolveAbcTarget(target, g3);
check("변환된 콤보도 고르지 않는다", t.widget === null);

// 표시 전용 칸: 허용된 노드 종류여도 저장 안 되거나 읽기 전용이면 고르지 않는다.
// (허용 목록 밖 노드로 시험하면 종류 검사에서 먼저 걸러져 이 보호를 검증하지 못한다)
const guarded = [
  ["serialize:false", { serialize: false }],
  ["options.serialize:false", { options: { serialize: false } }],
  ["options.readonly", { options: { readonly: true } }],
  ["options.read_only", { options: { read_only: true } }],
  ["inputEl.readOnly", { inputEl: { readOnly: true } }],
  ["element.readOnly", { element: { readOnly: true } }],
];
for (const [label, extra] of guarded) {
  g3.nodes[51] = { id: 51, type: "PrimitiveStringMultiline", mode: 0, outputs: [{ name: "STRING" }],
    widgets: [Object.assign({ name: "value", type: "customtext", value: "P" }, extra)] };
  t = resolveAbcTarget(target, g3);
  check("허용 노드라도 " + label + " 칸은 고르지 않는다", t.widget === null);
}
// 같은 노드에서 보호 속성만 빼면 고른다 — 위 검사가 종류 검사 덕에 통과한 게 아님을 보인다
g3.nodes[51] = { id: 51, type: "PrimitiveStringMultiline", mode: 0, outputs: [{ name: "STRING" }],
  widgets: [{ name: "value", type: "customtext", value: "P", options: {} }] };
t = resolveAbcTarget(target, g3);
check("보호 속성이 없으면 같은 노드를 고른다", t.widget === g3.nodes[51].widgets[0]);

// 모르는 노드는 칸 이름·출력 이름이 그럴듯해도 쓰지 않는다
g3.nodes[51] = { id: 51, type: "SomeTextBox", mode: 0, outputs: [{ name: "text" }],
  widgets: [{ name: "text", type: "customtext", value: "T" }] };
t = resolveAbcTarget(target, g3);
check("모르는 노드는 이름이 맞아도 쓰지 않는다", t.widget === null && t.reason === "linked-node-has-no-text-box");

// 출력이 여럿인 노드, 두 번째 출력에서 나온 선
g3.nodes[51] = { id: 51, type: "TwoOut", mode: 0, outputs: [{ name: "value" }, { name: "text" }],
  widgets: [{ name: "value", type: "customtext", value: "V" }, { name: "text", type: "customtext", value: "T" }] };
g3.links[41] = { origin_id: 51, origin_slot: 1 };
t = resolveAbcTarget(target, g3);
check("출력이 여럿이면 쓰지 않는다", t.widget === null);
g3.nodes[51] = { id: 51, type: "PrimitiveNode", mode: 0, outputs: [{ name: "STRING" }],
  widgets: [{ name: "value", type: "customtext", value: "P" }] };
t = resolveAbcTarget(target, g3);
check("알려진 노드라도 0번 아닌 출력이면 쓰지 않는다", t.widget === null);
console.log(fails ? "FAILED " + fails : "ALL PASS");
process.exit(fails ? 1 : 0);
