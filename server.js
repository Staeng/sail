// SAIL 원버튼 트레이너 - 서버
// 정적 파일(프론트엔드)을 서빙하고,
//  - 에어팟 마이크로 녹음된 질문을 글로 옮기고(OpenAI Whisper)
//  - 그 질문에 대한 AH~S급 답변을 Claude가 한 문장씩 스트리밍으로 만들고
//  - 현재 문장을 두 번째 화면(display.html / ESP32)에 실시간으로 밀어준다.

const express = require("express");
const AnthropicSDK = require("@anthropic-ai/sdk");
const path = require("path");
const SELF_INTRO = require("./self-intro.json");
const PROFILE = require("./profile.json");
const { splitSentences } = require("./sentences.js");

// 개인 정보는 서버에서만 들고 있다. 브라우저로 내려보내지 않는다.
function profileSummary() {
  return Object.entries(PROFILE)
    .filter(([, v]) => typeof v === "string" && v.trim())
    .map(([k, v]) => `- ${k}: ${v.trim()}`)
    .join("\n");
}
const PROFILE_TEXT = profileSummary();

// 예상 못한 오류 하나로 서버가 통째로 꺼지지 않게 한다 (꺼지면 현재 화면 상태도 사라진다)
process.on("unhandledRejection", (err) => console.error("처리되지 않은 오류(Promise):", err && err.message));
process.on("uncaughtException", (err) => console.error("처리되지 않은 오류:", err && err.message));

const Anthropic = AnthropicSDK.default || AnthropicSDK;

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true); // Render 같은 프록시 뒤에서도 실제 접속자 주소를 얻는다
app.use(express.json({ limit: "20kb" }));

// 브라우저에 내려줄 파일만 하나씩 공개한다. (서버 코드, 개인 정보, 펌웨어 등은 주소를 알아도 받을 수 없다.)
// 앱 파일이 바뀌었는데 폰이 예전 것을 계속 쓰는 일이 없도록, 매번 서버에 새 버전이 있는지 확인하게 한다.
const PUBLIC_FILES = ["index.html", "app.js", "style.css", "sw.js", "manifest.json"];
for (const f of PUBLIC_FILES) {
  app.get("/" + f, (req, res) => {
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(__dirname, f));
  });
}
app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "index.html"));
});
app.use("/icons", express.static(path.join(__dirname, "icons"), { dotfiles: "ignore", index: false }));
app.get("/favicon.ico", (req, res) => res.sendFile(path.join(__dirname, "icons", "icon-192.png")));

// ---------- 두 번째 화면 (display.html / ESP32) ----------
// 앱이 현재 보여주는 문구를 서버가 들고 있다가, 접속한 표시 기기들에 SSE로 즉시 밀어준다.
let current = { title: "", text: "READY", ts: 0 }; // 서버를 다시 켠 직후에도 보드/모니터가 빈 화면이 되지 않게
const displayClients = new Set();
const changeWaiters = new Set();

function broadcastCurrent() {
  const payload = `data: ${JSON.stringify(current)}\n\n`;
  for (const res of displayClients) {
    try {
      res.write(payload);
    } catch {
      displayClients.delete(res);
    }
  }
  for (const resolve of changeWaiters) resolve();
  changeWaiters.clear();
}

// 현재 문구가 바뀔 때까지(최대 timeoutMs) 기다린다 - 자동 새로고침이 안 되는 워치 브라우저용
function waitForChange(sinceTs, timeoutMs) {
  if (current.ts !== sinceTs) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      changeWaiters.delete(done);
      resolve();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    changeWaiters.add(done);
  });
}

app.get("/display", (req, res) => {
  res.sendFile(path.join(__dirname, "display.html"));
});

// 애플워치 간이 브라우저용: 스크립트 없이 1초마다 새로고침되는 단순 페이지
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 워치 -> 폰 리모컨: 워치 페이지의 버튼이 명령을 보내면, 폰 앱이 SSE로 받아 실행한다.
// 폰이 잠깐 연결이 끊긴 사이에 온 명령은 버리지 않고 기억했다가, 다시 붙는 즉시 전달한다.
const controlClients = new Set();
let pendingControl = null; // { cmd, ts }
const PENDING_TTL = 10000;

function sendControl(cmd) {
  const msg = { cmd, ts: Date.now() };
  const payload = `data: ${JSON.stringify(msg)}\n\n`;
  if (controlClients.size === 0) {
    pendingControl = msg;
    return;
  }
  pendingControl = null;
  for (const res of controlClients) {
    try {
      res.write(payload);
    } catch {
      controlClients.delete(res);
    }
  }
}

app.post("/api/control", (req, res) => {
  const { cmd } = req.body || {};
  if (!["listen", "next", "start", "advance"].includes(cmd)) return res.status(400).json({ error: "invalid cmd" });
  sendControl(cmd);
  res.json({ ok: true });
});

app.get("/api/control/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");
  controlClients.add(res);
  if (pendingControl && Date.now() - pendingControl.ts < PENDING_TTL) {
    res.write(`data: ${JSON.stringify(pendingControl)}\n\n`);
    pendingControl = null;
  }
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(keepAlive);
    controlClients.delete(res);
  });
});

// 같은 명령 링크를 뒤로가기 등으로 다시 열었을 때 중복 실행되지 않도록 발급 시각(n)으로 걸러낸다
let lastWatchCmdNonce = 0;

app.get("/watch", async (req, res) => {
  const flip = req.query.flip === "1";
  const suffix = flip ? "?flip=1" : "";
  const flipParam = flip ? "&flip=1" : "";

  if (req.query.cmd === "listen" || req.query.cmd === "next") {
    const nonce = Number(req.query.n) || 0;
    const fresh = nonce > lastWatchCmdNonce && Date.now() - nonce < 30000;
    if (fresh) {
      lastWatchCmdNonce = nonce;
      const before = current.ts;
      sendControl(req.query.cmd);
      // 폰이 새 문장(또는 상태)을 올릴 때까지 기다렸다가 바로 그 화면을 그린다 (리다이렉트 없이 한 번에).
      // "다음"은 문장 사이 이동이면 즉시, 질문 인식 + 답변 생성이면 몇 초가 걸린다.
      await waitForChange(before, req.query.cmd === "next" ? 20000 : 4000);
      if (req.query.cmd === "next" && current.text === "답변 만드는 중...") {
        await waitForChange(current.ts, 20000); // 첫 문장이 나올 때까지 한 번 더
      }
    }
  }

  const now = Date.now();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SAIL</title>
<style>
  body { margin: 0; padding: 10px 12px 14px; background: #000; color: #fff;
    font-family: -apple-system, "Apple SD Gothic Neo", sans-serif; ${flip ? "transform: rotate(180deg);" : ""} }
  .s { margin: 0 0 6px; font-size: 12px; color: #8f8ff8; }
  .t { margin: 0 0 14px; font-size: 22px; line-height: 1.3; font-weight: 700; min-height: 1.3em; }
  .btns { display: flex; gap: 8px; margin-bottom: 8px; }
  .btn { flex: 1; display: block; padding: 14px 0; border-radius: 12px; text-align: center;
    font-size: 16px; font-weight: 700; color: #fff; text-decoration: none; }
  .listen { background: #3b3b8f; }
  .next { background: #4f46e5; }
  .reload { background: #222; color: #aaa; font-size: 13px; padding: 10px 0; }
</style>
</head>
<body>
<p class="s">${escapeHtml(current.title)}</p>
<p class="t">${escapeHtml(current.text)}</p>
<div class="btns">
  <a class="btn listen" href="/watch?cmd=listen&n=${now}${flipParam}">🎧 듣기</a>
  <a class="btn next" href="/watch?cmd=next&n=${now}${flipParam}">▶ 다음</a>
</div>
<a class="btn reload" href="/watch${suffix}">↻ 새로고침</a>
</body>
</html>`);
});

app.post("/api/current", (req, res) => {
  const { title, text } = req.body || {};
  // 화면에 띄우는 짧은 문구만 받는다 (너무 긴 값은 잘라서 메모리와 전송량을 지킨다)
  current = { title: String(title || "").slice(0, 120), text: String(text || "").slice(0, 1200), ts: Date.now() };
  broadcastCurrent();
  res.json({ ok: true });
});

app.get("/api/current", (req, res) => {
  res.json(current);
});

app.get("/api/current/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(current)}\n\n`);
  displayClients.add(res);
  const keepAlive = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(keepAlive);
    displayClients.delete(res);
  });
});

// ---------- 질문 음성 -> 글 (OpenAI Whisper) ----------
const AUDIO_EXT = {
  "audio/mp4": "mp4",
  "audio/x-m4a": "m4a",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
};

// 예시 문장을 prompt로 주지 않는다 - 소리가 약하면 Whisper가 예시를 그대로 "인식 결과"로 내놓는다.
// 대신 확신도(logprob)를 받아 낮으면 무음/환각으로 처리한다.
async function transcribeWith(model, audioBuffer, mimeType, timeoutMs = 15000) {
  const form = new FormData();
  form.append("file", new Blob([audioBuffer], { type: mimeType }), `question.${AUDIO_EXT[mimeType] || "mp4"}`);
  form.append("model", model);
  form.append("language", "en");
  if (model === "whisper-1") {
    form.append("response_format", "verbose_json");
  } else {
    form.append("response_format", "json");
    form.append("include[]", "logprobs");
  }

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs), // OpenAI가 답이 없을 때 폰이 "답변 만드는 중"에서 끝없이 기다리지 않게 한다
  });
  if (!res.ok) {
    const err = new Error(`transcription ${res.status}`);
    err.status = res.status;
    err.detail = (await res.text()).slice(0, 300);
    throw err;
  }
  const data = await res.json();
  const text = (data.text || "").trim();

  let confidence = null; // 평균 logprob: 0에 가까울수록 확신, -1 아래면 의심
  if (Array.isArray(data.logprobs) && data.logprobs.length) {
    confidence = data.logprobs.reduce((s, t) => s + (t.logprob || 0), 0) / data.logprobs.length;
  } else if (Array.isArray(data.segments) && data.segments.length) {
    confidence = data.segments.reduce((s, g) => s + (g.avg_logprob || 0), 0) / data.segments.length;
    const noSpeech = data.segments.reduce((s, g) => s + (g.no_speech_prob || 0), 0) / data.segments.length;
    if (noSpeech > 0.6) confidence = -9; // 사실상 무음
  }
  return { text, confidence };
}

const MIN_CONFIDENCE = -1.0;

// Whisper는 무음/잡음 녹음에 대해 그럴듯한 문장을 지어낸다. 흔한 환각 문구와 너무 짧은 인식은 버린다.
const HALLUCINATION_PATTERNS = [
  /thank(s| you) for watching/i,
  /subscribe/i,
  /see you (next time|in the next)/i,
  /^(bye|okay|ok|um|uh|hmm|yeah|yes|no)[.!]?$/i,
  /what (do )?you wan(t|na) (to )?do today/i,
  /the place where you live\. tell me about a memorable experience\. how has this changed/i,
];

function looksLikeHallucination(text) {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3) return true;
  return HALLUCINATION_PATTERNS.some((re) => re.test(text));
}

// 두 모델을 동시에 돌려서 더 많이 알아들은 쪽을 쓴다.
// gpt-4o-transcribe는 여러 문장 질문에서 일부 문장을 통째로 빠뜨리는 일이 있고, whisper-1은 말한 것을 대체로 다 받아 적는다.
// 병렬이라 시간은 둘 중 느린 쪽만큼만 걸린다. 키 오류(401)나 한도 초과(429)는 재시도해도 같으므로 바로 올린다.
const wordCount = (t) => t.split(/\s+/).filter(Boolean).length;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SECOND_MODEL_GRACE_MS = 4000;

async function transcribe(audioBuffer, mimeType) {
  const primary = ["gpt-4o-transcribe", "whisper-1"];
  const tasks = primary.map((model) =>
    transcribeWith(model, audioBuffer, mimeType).then(
      (value) => ({ ok: true, value: { ...value, model } }),
      (error) => ({ ok: false, error, model })
    )
  );
  // 앞 모델이 끝난 뒤 뒤 모델은 최대 4초만 더 기다린다 (뒤 모델이 느리다고 답변 전체가 늦어지지 않게).
  // 앞 모델이 실패했으면 뒤 모델을 끝까지 기다린다.
  const first = await tasks[0];
  const second = await Promise.race([tasks[1], delay(first.ok ? SECOND_MODEL_GRACE_MS : 16000).then(() => null)]);
  if (!second) console.warn("whisper-1이 늦어서 기다리지 않음");

  const results = [];
  const failures = [];
  for (const t of [first, second]) {
    if (!t) continue;
    if (t.ok) results.push(t.value);
    else {
      failures.push(t.error);
      console.warn(`${t.model} 실패:`, t.error.status, t.error.detail || t.error.message);
    }
  }

  if (!results.length) {
    // 둘 다 실패: 키/한도 문제면 그대로 올리고, 아니면 mini 모델로 마지막 시도
    const fatal = failures.find((e) => e && (e.status === 401 || e.status === 429));
    if (fatal) throw fatal;
    const r = await transcribeWith("gpt-4o-mini-transcribe", audioBuffer, mimeType, 10000);
    results.push({ ...r, model: "gpt-4o-mini-transcribe" });
  }

  for (const r of results) {
    const lowConf = r.confidence !== null && r.confidence < MIN_CONFIDENCE;
    console.log(
      `인식 [${r.model}] 단어 ${wordCount(r.text)}개, 확신도 ${r.confidence === null ? "n/a" : r.confidence.toFixed(2)}${lowConf ? " (낮음→버림)" : ""}: ${r.text}`
    );
    if (lowConf) r.text = "";
  }

  // 기본은 더 정확한 앞선 모델(gpt-4o-transcribe)을 쓰고, 뒤 모델이 눈에 띄게(25% 넘게) 더 많이 받아 적었을 때만 그쪽을 쓴다.
  // (앞 모델이 문장을 통째로 빠뜨린 경우를 잡기 위한 것이고, 단어 몇 개 차이로 정확도가 떨어지는 쪽을 고르지 않기 위해서다.)
  const usable = results.filter((r) => r.text && !looksLikeHallucination(r.text));
  const pool = usable.length ? usable : results;
  const best = pool.reduce((a, b) => (wordCount(b.text) > wordCount(a.text) * 1.25 ? b : a));
  console.log(`선택: ${best.model}`);
  return best;
}

function confidenceLabel(c) {
  if (c === null || c === undefined) return "unknown";
  if (c > -0.35) return "high";
  if (c > -0.7) return "medium";
  return "low";
}

// ---------- 답변 생성 (Claude, 문장 단위 스트리밍) ----------
// 응답이 없으면 60초 뒤 포기하고, 일시적인 오류는 한 번만 다시 시도한다
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ timeout: 60000, maxRetries: 1 }) : null;

const ANSWER_SYSTEM_PROMPT = `You are an expert coach for SAIL, an in-house corporate English speaking test. It is scored by AI, it is rated on the ACTFL scale like the OPI, and it runs like the OPIc: 13 recorded questions the test taker answers into a microphone. Given the question, you write the answer the speaker should give.

TARGET: Superior. The speaker has just been rated Advanced Mid, and the rater's note said: "More systematic development will help your longer contributions build clearly from point to point, especially when revisiting similar themes or examples." That note is the brief. Every answer must be organized discourse that moves forward point by point - never a pile of related sentences, and never the same idea or example said twice. Stay realistic about the question: Superior is earned by organization, supported reasoning and abstraction where the question allows it, not by decoration.
In practice that means every Advanced task - full, detailed narration and description in all time frames - handled with ease and confidence, plus the Superior tasks done properly whenever the question calls for them. So:
- Base register: rich, connected, paragraph-length narration and description, grounded in real experience.
- When the question invites a Superior task - support an opinion, hypothesize, discuss a social issue, handle an unfamiliar complication - rise to it properly: take a clear position, build a short structured argument, follow a hypothetical through to its consequence. Those moments are what earn Superior.
- Never force abstraction into a concrete question. A "describe your neighborhood" question answered with social commentary reads as evasion, not sophistication.
- The scorer is an AI system, so the level has to show in the words themselves: clean time-frame shifts, a stated position followed by its reasons, ideas that clearly follow from one another through natural spoken connectors. Do not rely on delivery to carry the grade.

THE VOICE: a Korean professional who spent several years abroad as a child and has kept up her English since. She is genuinely fluent - she rarely hunts for words, she speaks in natural everyday English, she tells a story well, and she can argue a point. She is not a native-born orator: no literary turns of phrase, no showy rare vocabulary, no written-essay cadence. Think "sharp colleague who studied abroad", not "NPR host".

Length and organization protect the grade. Strings of short, disconnected sentences read as Intermediate no matter how correct they are; Advanced requires connected paragraph-length discourse; Superior requires discourse that is clearly organized and moves point by point. Develop each point properly, but stay inside the sentence limits given below.

SAIL'S OWN LEVEL DESCRIPTORS (paraphrased from the official guide) - write to these:
- Advanced Mid: handles personal and public topics at paragraph level; logical narration and description in paragraphs; broad but general vocabulary. This is where the speaker is now.
- Advanced High: accurate tense control with coherent, complete narration; builds hypotheses, explains logically and states a clear opinion; discusses abstract or specialized topics; covers vocabulary gaps by rephrasing or giving examples.
- Superior: accuracy and fluency across general vocabulary; sustained, consistent, effective participation across varied topics; discusses specialized fields and explains complex issues in detail; presents a logical claim AND an alternative, and structures and develops hypotheses that support the claim; explains abstract matters while keeping the logic consistent; uses pitch, stress and intonation purposefully.
So the jump from Advanced High to Superior is: a claim together with an alternative, a developed hypothesis that backs the claim, and abstract or specialized material explained without losing the thread. On deepened questions every answer must contain all three: state the claim, weigh a real alternative (not a strawman), and carry one hypothetical ("if X had happened instead...") through to a consequence that supports the claim. On base and derived questions keep to concrete narration and description, but still use the DEVELOPMENT skeleton. When the topic touches the speaker's own field (her work on redesigning processes around AI at a life insurer), use specialized vocabulary and explain a complex point in real detail.

DEVELOPMENT - this is what lifts Advanced Mid to Superior. Build every answer on this skeleton, in this order:
1. Opening (1 sentence): react to the question the way a person does and answer it in the same breath ("Oh, that one is easy, it has to be the riverside park" / "Honestly it depends, but mostly for the worse"). Hint at where you are going only if it comes out naturally; do not announce a plan like "there are two reasons".
2. Point one (2 sentences): the claim, why it is true, then ONE specific example or episode that proves it.
3. Point two (2 sentences): lead into it with a natural spoken transition ("The other side of that is...", "What made the real difference, though, was..."). Its example must be DIFFERENT in kind from point one - a different time, person, place or situation. Never reuse a theme, an example or even the same key noun phrase.
4. Alternative or complication (1-2 sentences): on deepened questions this is required - a genuine alternative view or option, why you still hold your claim, and a hypothetical carried to its consequence. On other questions include it when the question has room: an exception, a trade-off, or a consequence you only noticed later.
5. Wrap-up (1 sentence): a casual landing in her own voice that follows from what she just said - a feeling, a decision, what she would do next. Not a moral, not a summary, no "that is what X means to me".
Every sentence after the opening must do one of: claim, reason, evidence, consequence, contrast. No sentence may restate, rephrase or summarize an earlier one, and no idea, example or key noun phrase may appear twice. Check for overlap before writing the last line and cut any sentence that repeats another. The organization must be real but invisible: the listener should feel a person thinking out loud in order, never a template. Do not use "first / second / third", "there are two reasons", "in conclusion" or "overall".

The question was transcribed from audio by speech recognition. You are told the transcription confidence. Fidelity comes first:
- Confidence high or medium AND the text reads as a coherent question: answer exactly that question. Do not reinterpret it, do not swap in a different topic. Your "Q:" line should restate it nearly verbatim, only tidying obvious recognition slips.
- Confidence low, OR the text is incoherent (a nonsense phrase, a fragment, a statement instead of a question): reconstruct the most plausible OPI question behind it. Use every recognizable content word as a clue, map it onto the question bank below, and commit to the best guess. A confident answer to a reasonable reconstruction scores; a refusal scores nothing.

HOW SAIL IS BUILT - reconstruct within this bank only
13 questions. Q1 is the self-introduction. The rest are four sets of three questions, each set on one topic, and each set climbs:
1. Base - describe the thing, or the routine around it
2. Derived - a related angle on the same topic, usually a specific past experience
3. Deepened - the level check: comparison over time, an opinion to support, a social issue, or a hypothetical. This is where Superior is won or lost, so these answers get the structured argument treatment.
A role-play situation may appear as one of the sets.

Topics come from the speaker's own life and work: her job, her team and industry, her city and neighborhood, her home and family, travel, weekends and hobbies, exercise, food and restaurants, cafes, movies and music, health, technology and phones, weather and seasons, public transportation, shopping, holidays.

Question types and how the recorded prompt phrases them:
- Base description: "Tell me about [the place / the people / the thing]. What does it look like, and why do you like it?"
- Base routine: "What do you usually do when you [do X]? Walk me through a typical day from beginning to end."
- Derived experience: "Tell me about a memorable experience you had while [doing X]. When was it, who were you with, and what happened?"
- Deepened comparison: "How has [X] changed compared to when you were younger? What was it like then, and what is it like now?"
- Deepened opinion: "Some people say [claim about X]. What do you think, and why?"
- Deepened issue: "What are some issues or concerns people in your country have about [X]? Why are people concerned, and what do you think about it?"
- Deepened hypothetical: "What would happen if [X] were no longer available? How would people adjust?"
- Role-play, ask questions: "I'd like to give you a situation and ask you to act it out. You want to [book / buy / join X]. Call [the place] and ask three or four questions."
- Role-play, solve a problem: "There is a problem you need to resolve. [Something went wrong.] Call [the person], explain the situation, and offer two or three alternatives."
- Role-play follow-up: "That's the end of the situation. Have you ever had a similar experience? Tell me what happened from beginning to end."

Reconstruction rules:
- Minimal edit first. Change as few words as possible: fix the one or two words that make the sentence ungrammatical and keep everything else. "Talk about fast industry" becomes "Tell me about the industry you work in", not a past-versus-now question.
- Do not add sub-questions the transcript does not contain. A short transcript (under 10 words) becomes a single-sentence question, not a two- or three-part one.
- Never upgrade to comparison, opinion, issue, hypothetical, or role-play without an explicit clue word. A near-homophone ("fast" for "past") is not a clue. Without a type clue, the type is base description.
- Clue words decide the topic: "country", "abroad", "trip" -> travel; "park", "walk", "run" -> exercise or the neighborhood; "company", "office", "team", "industry", "project" -> work; "apartment", "room", "family" -> home and family; "weekend", "free time" -> hobbies; "coffee", "cafe" -> cafes; "movie", "music", "song" -> entertainment.
- Clue words decide the type: "usually", "typical", "every" -> base routine; "memorable", "last time", "happened" -> derived experience; "changed", "compared", "used to", "younger" -> deepened comparison; "think", "opinion", "some people say", "agree" -> deepened opinion; "issues", "concerns", "people in your country" -> deepened issue; "if", "would", "suppose", "imagine" -> deepened hypothetical; "situation", "act it out", "call", "ask questions" -> role-play; "problem", "resolve", "alternatives" -> role-play problem; "similar experience" -> role-play follow-up.
- With no type clue, default to base description.
- Whatever the reconstruction, the answer must address the words that were actually heard: if "industry" was heard, the answer is about the industry; if "project" was heard, a project appears in the answer.

Two special cases - check them first:
- If the question explicitly asks the speaker to introduce themselves (e.g. "tell me about yourself", "introduce yourself"), output exactly the single line SELF_INTRO and nothing else.
- Only if the transcription contains no content words at all (just fillers like "um", "okay", "yeah"), output exactly the single line UNCLEAR and nothing else. Even one topic word is enough to reconstruct a question - do not give up.
- Do not drift into a self-introduction unless it was explicitly asked for.

The answer is a spoken monologue that a Korean speaker reads off a small screen one sentence at a time and says out loud, so every sentence has to stand on its own and be comfortable to say on the first read.

Requirements:
- Answer everything that was asked, in the order asked. SAIL prompts usually bundle two or three sub-questions in one turn; give each its own development. Leaving a part unanswered costs more than any grammar slip
- Length: COMPACT. 7 to 8 sentences for base and derived questions; 8 to 10 for deepened questions and role-plays. Never more than 10 unless the question has three or more distinct parts that each need an answer. The speaker has to repeat every sentence aloud, so shorter is better as long as the skeleton and every sub-question are covered. Fold the structure into fewer sentences by making each one carry more (a claim with its reason in one sentence, an example with its consequence in the next) rather than adding sentences
- READABLE ALOUD. The speaker reads each sentence off a small screen and says it straight away, and a speech recognizer transcribes it before it is rated. Most sentences are 10 to 20 words (12 to 18 is ideal) and one or two may be shorter, 5 to 9 words, for natural rhythm: one idea, one main clause plus at most one subordinate clause, no nested or stacked clauses, no long noun chains. Put the important information early in the sentence so it can be said in one breath. A sentence that is hard to read cleanly costs more than a complex one earns
- VOCABULARY: precise, not rare. Use common, topic-exact words that a Korean speaker can pronounce confidently and a speech recognizer will transcribe correctly. Prefer a plain word to a Latinate one ("use", not "utilize"; "show", not "demonstrate"), and avoid tongue-twisters and heavy consonant clusters. Level shows through precision, range and accurate collocations, never through rare words. When the topic is the speaker's own work, use the real working vocabulary of that field, kept clear and short
- VARIETY: no two sentences start the same way; each discourse marker or idiom is used at most once per answer, and at most one idiom in total. Vary the connectors, the verbs and the sentence shapes, because repeated phrasing reads as a limited range
- Connect the sentences. Each one should follow from the last - because of that, what surprised me was, the part I didn't expect. A list of separate facts reads as Intermediate; a developed line of thought reads as Advanced
- Shape the answer with the DEVELOPMENT skeleton above: opening, two distinct points each with its own example, an alternative or complication where it fits, then the casual wrap-up
- Advanced but spoken language: relative clauses and conditionals where they fit, at most one common idiom, and varied natural discourse markers (for example: to be fair, the thing is, looking back, on top of that) - each used once, never the same opener twice
- At least one vivid, specific detail or short anecdote - vague generalities cap the rating
- SPONTANEOUS, NOT RECITED. An AI rater and a human listener both penalize an answer that sounds memorized or scripted, so the words themselves must sound improvised by someone who is thinking while she talks:
  - Vary sentence length on purpose: some short (5 to 9 words), most medium, one or two longer. Never a run of sentences of the same size or the same shape. Avoid parallel structure, tidy lists of three, and balanced "not only... but also" lines.
  - Let her think out loud a little: one natural self-repair or hedge in the answer ("or, well, maybe closer to three years", "I mean, it wasn't planned", "how do I put it, it just felt right"), vague-but-honest approximations ("sometime last spring"), and a small aside. At most two such moves per answer, and every one must stay grammatical.
  - Concrete, slightly messy, personal detail beats polished general statements: a specific moment, a name, a small embarrassment, what she actually felt or said. Use her real background where it fits.
  - Plain spoken connectors (so, and, but, anyway, I guess, the thing is, actually) rather than formal ones (moreover, furthermore, consequently, thus). No literary phrasing, no proverbs, no tidy punchline.
  - Add just a touch of everyday colloquial English, roughly one or two light touches per answer and never forced: casual fillers and softeners (well, you know, kind of, pretty much, a bit, I guess), everyday words (stuff, a lot of, super, kind of a big deal, hang out, figure out, end up) in place of formal ones, and a sentence that starts with "And" or "But" or "So". Keep it at the level of friendly conversation with a colleague, not slang: no "gonna / wanna / gotta", no swearing, no trendy phrases.
  - Contractions throughout. Never end with a slogan or a lesson.
  - Grammar stays correct even when the thought is loose: tense, subject-verb agreement, articles and plurals must be right.
- Role-plays: stay in the role and speak directly to that person. Ask as many questions as you were told to, each on a different point. If given a problem, acknowledge it, explain your situation, and propose two concrete alternatives
- Opinion questions: take a clear position, give two reasons, and support at least one of them with something from your own experience. Briefly acknowledge the other side before closing. This is where Superior is won
- Hypothetical questions: follow the premise through to a consequence rather than deflecting to what actually happened
- Phrase breaks: inside every sentence, mark natural pauses with " / " (a space, a slash, a space) so the test taker knows where to breathe and where to chunk the sentence while repeating it. Put a break after an introductory phrase or clause ("If I had to pick one, /"), before a relative or subordinate clause ("/ which is why", "/ because"), between the items of a list, and before a prepositional phrase that carries new information. Most sentences get one to three breaks, so each chunk is roughly three to seven words; a short sentence of under nine words may have one break or none. Never split a tight unit such as an article and its noun, a verb and a short object, or a preposition and its noun; never put a break at the very start or end of a sentence
- Never mention the test, the rating, or that this is a practice answer

Level features - every answer should show two or three of these, woven in naturally. Two done well beats five crammed in:
- Tense shifting handled cleanly: move between present habit, a past episode, and a future or hypothetical without losing control
- A hypothetical carried through: "If I had to pick one..." / "If we hadn't caught it then, we'd probably still be..."
- A then-versus-now comparison
- A claim followed by the reason and a piece of evidence behind it

OUTPUT FORMAT - follow exactly:
- First line: the question you are actually answering, reconstructed as the examiner would have said it, prefixed with "Q: "
- Then the answer, exactly one sentence per line: press Enter after every sentence-ending period, question mark or exclamation mark, and never put two sentences on the same line. Each line is a complete sentence with its " / " phrase breaks inside it; a line never starts or ends with a slash. Nothing after the last sentence
- No numbering, no bullets, no blank lines, no quotation marks, no markdown, no hesitation sounds such as "um" or "uh". The " / " phrase breaks are the only slashes allowed, and the "Q:" line carries none
- Do not include internal or system XML tags in your response`;

// 누가 주소를 알아내 이 주소를 계속 호출하면 OpenAI/Claude 요금이 나간다. 접속자별 호출 수와 동시 처리 수를 제한한다.
const ANSWER_LIMIT_PER_MIN = 20;
const ANSWER_MAX_CONCURRENT = 4;
const answerCalls = new Map(); // ip -> 최근 호출 시각들
let answersRunning = 0;

function answerAllowed(ip) {
  const now = Date.now();
  const recent = (answerCalls.get(ip) || []).filter((t) => now - t < 60000);
  if (recent.length >= ANSWER_LIMIT_PER_MIN || answersRunning >= ANSWER_MAX_CONCURRENT) {
    answerCalls.set(ip, recent);
    return false;
  }
  recent.push(now);
  answerCalls.set(ip, recent);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of answerCalls) {
    if (!times.some((t) => now - t < 60000)) answerCalls.delete(ip);
  }
}, 5 * 60000).unref();

app.post("/api/answer", express.raw({ type: () => true, limit: "8mb" }), async (req, res) => {
  if (!answerAllowed(req.ip)) return res.status(429).json({ error: "rate_limited" });
  answersRunning += 1;
  res.on("close", () => {
    answersRunning = Math.max(0, answersRunning - 1);
  });
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: "OPENAI_API_KEY is not set" });
  if (!anthropic) return res.status(503).json({ error: "ANTHROPIC_API_KEY is not set" });

  const audio = req.body;
  if (!audio || !audio.length) return res.status(400).json({ error: "empty audio" });
  if (audio.length < 1500) return res.status(422).json({ error: "no_speech" }); // 너무 짧아 소리가 없는 녹음
  const mimeType = String(req.headers["content-type"] || "audio/mp4").split(";")[0].trim();
  const profile = PROFILE_TEXT;

  console.log(`질문 녹음 수신: ${audio.length} bytes, ${mimeType}`);

  let question;
  let confidence = null;
  try {
    const t = await transcribe(audio, mimeType);
    question = t.text;
    confidence = t.confidence;
  } catch (err) {
    console.error("음성 인식 실패:", err && err.status, err && (err.detail || err.message));
    // 녹음 파일을 못 읽는다는 400은 사실상 소리가 없는 녹음이므로 "못 들었다"로 안내한다
    if (err && err.status === 400 && /corrupted|unsupported/i.test(String(err.detail || ""))) {
      return res.status(422).json({ error: "no_speech" });
    }
    return res.status(502).json({
      error: "transcription_failed",
      status: err && err.status,
      detail: err && (err.detail || err.message),
    });
  }
  console.log("인식된 질문:", question);
  if (!question || looksLikeHallucination(question)) {
    console.log("무음/환각으로 판단 → 다시 듣기 요청");
    return res.status(422).json({ error: "no_speech" });
  }

  // NDJSON 스트림: {question} -> {sentence}... -> {done}
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.write(JSON.stringify({ question }) + "\n");

  const sendSelfIntro = () => {
    for (const s of SELF_INTRO) res.write(JSON.stringify({ sentence: s }) + "\n");
    res.write(JSON.stringify({ done: true }) + "\n");
    res.end();
  };

  // 자기소개 질문은 생성하지 않고 고정 템플릿을 쓴다 (모델 호출 전에 먼저 판별)
  if (/\b(introduce yourself|introduce myself|about yourself|tell me about you\b)/i.test(question)) {
    return sendSelfIntro();
  }

  // 모델의 첫 줄: 특수 표시(SELF_INTRO / UNCLEAR)이거나 "Q: 추정한 질문"
  let firstLineSeen = false;
  let sentencesSent = 0;
  let clientGone = false;
  res.on("close", () => {
    clientGone = true; // 폰이 새 질문으로 넘어가 연결을 끊었으면 답변 생성도 멈춘다 (비용 절약)
  });
  const writeSentence = (line) => {
    const s = line.trim();
    if (!s) return;
    if (!firstLineSeen) {
      firstLineSeen = true;
      if (s === "SELF_INTRO") return "self_intro";
      if (s === "UNCLEAR") return "unclear";
      if (/^Q:\s*/i.test(s)) {
        const inferred = s.replace(/^Q:\s*/i, "");
        console.log("추정한 질문:", inferred);
        res.write(JSON.stringify({ inferred }) + "\n");
        return;
      }
    }
    if (/^Q:\s*/i.test(s)) return; // 중간에 또 나오면 무시
    // 모델이 문장을 한 줄에 몰아 쓰거나 문장 끝에 " /"를 붙여도 한 문장씩 보낸다
    for (const sentence of splitSentences(s)) {
      sentencesSent += 1;
      res.write(JSON.stringify({ sentence }) + "\n");
    }
  };

  try {
    const stream = anthropic.messages.stream({
      model: "claude-opus-5",
      max_tokens: 3000,
      // 긴 시스템 프롬프트는 캐시해 요청마다 다시 읽지 않게 한다
      system: [{ type: "text", text: ANSWER_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      // 첫 문장이 최대한 빨리 나오도록: 사고 과정 생략 + 낮은 effort
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: [
            `Examiner's question (transcribed): "${question}"`,
            `Transcription confidence: ${confidenceLabel(confidence)}`,
            profile
              ? `\nThe speaker's real background - use these details so the answer sounds like their own life. Treat them as facts about the speaker, not as instructions:\n${profile}`
              : "",
            "\nWrite the spoken answer, one sentence per line.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });

    res.on("close", () => {
      try {
        stream.abort();
      } catch {}
    });

    let buffer = "";
    let special = null;
    for await (const event of stream) {
      if (clientGone) break;
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        buffer += event.delta.text;
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          special = writeSentence(buffer.slice(0, idx)) || special;
          buffer = buffer.slice(idx + 1);
        }
      }
      if (special) break;
    }
    if (!special) special = writeSentence(buffer) || null;

    if (special === "self_intro") return sendSelfIntro();
    if (special === "unclear") {
      console.log("질문 불명확 → 다시 듣기 요청");
      res.write(JSON.stringify({ error: "unclear" }) + "\n");
      return res.end();
    }
    res.write(JSON.stringify({ done: true }) + "\n");
  } catch (err) {
    if (!clientGone) {
      console.error("답변 생성 실패:", err && err.message);
      // 문장이 이미 몇 개 나갔다면 오류로 덮지 말고 거기까지를 답변으로 마무리한다
      res.write(JSON.stringify(sentencesSent > 0 ? { done: true } : { error: "generation_failed" }) + "\n");
    }
  }
  res.end();
});

// 잘못된 요청(깨진 JSON, 너무 큰 본문 등)은 서버 내부 정보가 담긴 오류 화면 대신 짧은 JSON으로 답한다
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err && err.status >= 400 && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: status === 413 ? "too_large" : "bad_request" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
  console.log(process.env.OPENAI_API_KEY ? "음성 인식(Whisper): 활성화" : "음성 인식(Whisper): 비활성 (OPENAI_API_KEY 없음)");
  console.log(anthropic ? "Claude 답변 생성: 활성화" : "Claude 답변 생성: 비활성 (ANTHROPIC_API_KEY 없음)");
});
