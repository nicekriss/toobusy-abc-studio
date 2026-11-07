// ABC 악보 스튜디오 - ComfyUI 붙임 스크립트
// abc 텍스트 위젯을 가진 노드에 "악보 스튜디오 열기" 버튼을 붙인다.
import { app } from "../../scripts/app.js";
import { resolveAbcTarget } from "./abc_studio/resolve.js";
import { attachStudioButton } from "./abc_studio/button.js";

const STUDIO_URL = new URL("./abc_studio/index.html", import.meta.url).href;
const STYLE_ID = "abcst-style";

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
.abcst-back{position:fixed;inset:0;background:rgba(6,8,12,.62);z-index:10000;display:flex;align-items:center;justify-content:center}
.abcst-box{width:min(1400px,95vw);height:min(900px,92vh);background:#10131a;border:1px solid #2b313a;border-radius:14px;
 box-shadow:0 24px 70px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden}
.abcst-bar{display:flex;align-items:center;flex-wrap:wrap;flex-shrink:0;gap:10px;padding:9px 14px;background:#161a21;border-bottom:1px solid #0b0e13;
 color:#e8eaee;font:600 14px "Malgun Gothic","Segoe UI",system-ui,sans-serif}
.abcst-bar .sp{flex:1}
.abcst-bar .tip{color:#9aa1ad;font-weight:400;font-size:12.5px}
.abcst-bar button{background:#1f242c;color:#e8eaee;border:1px solid #2b313a;border-radius:8px;padding:6px 14px;
 cursor:pointer;font:inherit;font-weight:400}
.abcst-bar button:hover{background:#272d37}
.abcst-frame{flex:1 1 0;min-height:0;border:0;width:100%;background:#10131a}`;
  document.head.appendChild(st);
}

// 편집기를 띄운다. getAbc()로 지금 악보를 넘기고,
// 사용자가 "이 악보 쓰기"를 누르면 setAbc(text)로 돌려받는다.
function openStudio(getAbc, setAbc, describe) {
  ensureStyle();
  const back = document.createElement("div");
  back.className = "abcst-back";
  const box = document.createElement("div");
  box.className = "abcst-box";
  const bar = document.createElement("div");
  bar.className = "abcst-bar";

  const title = document.createElement("span");
  title.textContent = "ABC 악보 스튜디오";
  const tip = document.createElement("span");
  tip.className = "tip";
  const sp = document.createElement("span");
  sp.className = "sp";
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "닫기";
  bar.append(title, tip, sp, closeBtn);

  function setTip(text, warn) {
    tip.textContent = text;
    tip.style.color = warn ? "#ffb4ac" : "#9aa1ad";
  }
  setTip(describe ? describe() : "미리보기");

  const frame = document.createElement("iframe");
  frame.className = "abcst-frame";
  frame.src = STUDIO_URL;
  box.append(bar, frame);
  back.appendChild(box);
  document.body.appendChild(back);

  const onMsg = (e) => {
    const d = e.data;
    if (!d || d.source !== "abc-studio") return;
    if (frame.contentWindow && e.source !== frame.contentWindow) return;
    if (d.type === "ready") {
      let abc = "";
      try { abc = getAbc() || ""; } catch (_) {}
      frame.contentWindow.postMessage({ source: "abc-studio-host", type: "load", abc }, "*");
    } else if (d.type === "apply") {
      if (!setAbc) { close(); return; }
      const result = setAbc(String(d.abc || ""));
      // 넣을 자리를 못 찾으면 창을 닫지 않는다. 닫아 버리면 악보가 사라진다.
      if (result && result.ok === false) setTip(result.message, true);
      else close();
    }
  };
  const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
  function close() {
    window.removeEventListener("message", onMsg);
    window.removeEventListener("keydown", onKey, true);
    back.remove();
  }
  window.addEventListener("message", onMsg);
  window.addEventListener("keydown", onKey, true);
  closeBtn.onclick = close;
  back.addEventListener("mousedown", (e) => { if (e.target === back) close(); });
}

function linkProblem(reason) {
  if (reason === "link-cycle") return "abc 칸의 선이 빙 돌아 제자리로 돌아옵니다";
  if (reason === "link-too-deep") return "abc 칸의 선이 너무 여러 번 이어져 있어 출처를 찾지 못했습니다";
  return "abc 칸에 꽂힌 선의 출처를 찾지 못했습니다";
}

const OWN_NOT_TEXT = "이 노드의 abc 칸은 선택 목록이거나 읽기 전용이라 악보를 넣을 수 없습니다";

function nameOf(n) {
  return (n && (n.title || n.type)) || "연결된 노드";
}

// 꺼진 노드가 근원 자신인지, 가는 길 중간인지 구분해서 알려 준다
function offNote(t) {
  const off = t.disabledNode || t.node;
  if (off === t.node) return "그 노드가 꺼져 있어 켜야 악보가 반영됩니다";
  return `가는 길의 ${nameOf(off)} 노드가 꺼져 있어 그 노드를 켜야 악보가 반영됩니다`;
}

function describeTarget(node) {
  const t = resolveAbcTarget(node, app.graph);
  if (!t) return "이 노드에는 abc 칸이 없습니다";
  if (!t.node) return linkProblem(t.reason);
  const where = nameOf(t.node);
  if (t.reason === "own-widget-not-text") return OWN_NOT_TEXT;
  if (!t.widget) return `${where} 에는 악보를 그대로 내보내는 칸이 없습니다`;
  if (t.disabled) return `${where} 에 넣습니다. 다만 ${offNote(t)}`;
  if (t.viaLink) return `abc 칸에 선이 꽂혀 있어 ${where} 쪽에 넣습니다`;
  return "다 그린 뒤 아래 '이 악보 쓰기'를 누르면 이 노드에 들어갑니다";
}

function readAbc(node) {
  const t = resolveAbcTarget(node, app.graph);
  return t && t.widget ? t.widget.value : "";
}

function writeAbc(node, text) {
  const t = resolveAbcTarget(node, app.graph);
  if (!t) return { ok: false, message: "이 노드에는 abc 칸이 없습니다" };
  if (!t.node) return { ok: false, message: linkProblem(t.reason) + ". 선을 빼고 다시 시도하세요" };
  if (t.reason === "own-widget-not-text") return { ok: false, message: OWN_NOT_TEXT };
  if (!t.widget) {
    return { ok: false, message: `${nameOf(t.node)} 에는 악보를 그대로 내보내는 칸이 없습니다. abc 칸의 선을 빼거나 'ABC 악보 입력' 노드로 이어 주세요` };
  }
  t.widget.value = text;
  if (t.widget.callback) t.widget.callback(text, app.canvas, t.node);
  app.graph.setDirtyCanvas(true, true);
  if (t.disabled) {
    return { ok: false, message: `${nameOf(t.node)} 에 넣었습니다. 다만 ${offNote(t)}` };
  }
  return { ok: true };
}

function attachButton(node) {
  attachStudioButton(node, () => node.graph || app.graph, () => {
    openStudio(
      () => readAbc(node),
      (text) => writeAbc(node, text),
      () => describeTarget(node)
    );
  });
}

app.registerExtension({
  name: "toobusy.abc-studio",
  async nodeCreated(node) {
    // 위젯이 다 만들어진 뒤에 붙인다.
    setTimeout(() => { try { attachButton(node); } catch (_) {} }, 0);
  },
  async loadedGraphNode(node) {
    try { attachButton(node); } catch (_) {}
  },
  commands: [{
    id: "toobusy.abcStudio.open",
    label: "ABC 악보 스튜디오",
    function: () => openStudio(() => "", null, () => "미리보기"),
  }],
  menuCommands: [{ path: ["Extensions"], commands: ["toobusy.abcStudio.open"] }],
});
