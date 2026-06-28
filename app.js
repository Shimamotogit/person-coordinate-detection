"use strict";

const elements = {
  video: document.querySelector("#camera"),
  canvas: document.querySelector("#overlay"),
  questionText: document.querySelector("#questionText"),
  questionCounter: document.querySelector("#questionCounter"),
  statusText: document.querySelector("#statusText"),
  choiceLabels: document.querySelector("#choiceLabels"),
  startButton: document.querySelector("#startButton"),
  nextButton: document.querySelector("#nextButton"),
  resetButton: document.querySelector("#resetButton"),
  message: document.querySelector("#message")
};

const state = {
  model: null,
  stream: null,
  questions: [],
  settings: {
    pointsPerCorrectAnswer: 100,
    holdDurationMs: 1200,
    resultDisplayMs: 1300
  },
  order: [],
  orderPosition: 0,
  currentQuestion: null,
  score: 0,
  selectedZone: null,
  zoneEnteredAt: 0,
  answerLocked: false,
  running: false,
  animationFrameId: null,
  resultTimerId: null,
  lastDetectionAt: 0,
  latestPerson: null,
  detectionIntervalMs: 110
};

const context = elements.canvas.getContext("2d");

function shuffle(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function loadQuestions() {
  const response = await fetch("questions.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`questions.json の読み込みに失敗しました (${response.status})`);

  const data = await response.json();
  if (!Array.isArray(data.questions) || data.questions.length === 0) {
    throw new Error("questions.json に問題がありません");
  }

  data.questions.forEach((question, index) => {
    if (!question.text || !Array.isArray(question.choices) || question.choices.length < 2) {
      throw new Error(`問題 ${index + 1} の形式が不正です`);
    }
    if (!Number.isInteger(question.correctIndex) || question.correctIndex < 0 || question.correctIndex >= question.choices.length) {
      throw new Error(`問題 ${index + 1} の correctIndex が不正です`);
    }
  });

  state.questions = data.questions;
  state.settings = { ...state.settings, ...(data.settings ?? {}) };
  resetQuestionOrder();
}

function resetQuestionOrder() {
  state.order = shuffle(state.questions.map((_, index) => index));
  state.orderPosition = 0;
}

function showQuestion() {
  if (state.resultTimerId) {
    window.clearTimeout(state.resultTimerId);
    state.resultTimerId = null;
  }
  hideMessage();

  if (state.orderPosition >= state.order.length) resetQuestionOrder();

  state.currentQuestion = state.questions[state.order[state.orderPosition]];
  state.orderPosition += 1;
  state.answerLocked = false;
  state.selectedZone = null;
  state.zoneEnteredAt = 0;
  elements.nextButton.hidden = true;
  elements.questionText.textContent = state.currentQuestion.text;
  elements.questionCounter.textContent = `${state.orderPosition} / ${state.order.length}`;
  elements.statusText.textContent = "位置を選んでください";
  renderChoiceLabels();
}

function renderChoiceLabels() {
  const choices = state.currentQuestion?.choices ?? [];
  elements.choiceLabels.style.gridTemplateColumns = `repeat(${choices.length}, minmax(0, 1fr))`;
  elements.choiceLabels.replaceChildren(
    ...choices.map((choice, index) => {
      const node = document.createElement("div");
      node.className = "choice-label";
      node.dataset.index = String(index);
      node.textContent = choice;
      return node;
    })
  );
}

function resizeCanvas() {
  const rect = elements.video.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  elements.canvas.width = Math.round(rect.width * ratio);
  elements.canvas.height = Math.round(rect.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function getDisplayRect() {
  return elements.canvas.getBoundingClientRect();
}

function predictionToDisplayBox(prediction) {
  const [x, y, width, height] = prediction.bbox;
  const sourceWidth = elements.video.videoWidth;
  const sourceHeight = elements.video.videoHeight;
  const target = getDisplayRect();

  const scale = Math.max(target.width / sourceWidth, target.height / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const cropX = (renderedWidth - target.width) / 2;
  const cropY = (renderedHeight - target.height) / 2;

  const mirroredX = target.width - (x * scale - cropX) - width * scale;
  return {
    x: mirroredX,
    y: y * scale - cropY,
    width: width * scale,
    height: height * scale
  };
}

function zoneFromPerson(personBox) {
  if (!state.currentQuestion) return null;
  const choiceCount = state.currentQuestion.choices.length;
  const target = getDisplayRect();
  const footX = personBox.x + personBox.width / 2;
  const footY = personBox.y + personBox.height;
  const answerAreaTop = target.height * 0.66;

  if (footY < answerAreaTop || footX < 0 || footX > target.width) return null;
  return Math.min(choiceCount - 1, Math.floor((footX / target.width) * choiceCount));
}

function updateZoneSelection(zoneIndex, now) {
  if (state.answerLocked) return;

  if (zoneIndex === null) {
    state.selectedZone = null;
    state.zoneEnteredAt = 0;
    elements.statusText.textContent = "回答エリアへ移動してください";
    updateChoiceClasses();
    return;
  }

  if (state.selectedZone !== zoneIndex) {
    state.selectedZone = zoneIndex;
    state.zoneEnteredAt = now;
  }

  const heldMs = now - state.zoneEnteredAt;
  const remainingMs = Math.max(0, state.settings.holdDurationMs - heldMs);
  elements.statusText.textContent = remainingMs > 0
    ? `${state.currentQuestion.choices[zoneIndex]}：あと ${(remainingMs / 1000).toFixed(1)} 秒`
    : "回答を確定します";

  updateChoiceClasses();
  if (heldMs >= state.settings.holdDurationMs) submitAnswer(zoneIndex);
}

function updateChoiceClasses(result = null) {
  const labels = [...elements.choiceLabels.children];
  labels.forEach((label, index) => {
    label.classList.toggle("active", !state.answerLocked && index === state.selectedZone);
    label.classList.toggle("correct", result !== null && index === state.currentQuestion.correctIndex);
    label.classList.toggle("wrong", result !== null && !result && index === state.selectedZone);
  });
}

function submitAnswer(selectedIndex) {
  if (state.answerLocked) return;
  state.answerLocked = true;
  const correct = selectedIndex === state.currentQuestion.correctIndex;
  if (correct) state.score += state.settings.pointsPerCorrectAnswer;

  updateChoiceClasses(correct);
  elements.statusText.textContent = correct ? "正解！" : "不正解";
  showMessage(correct ? `正解！ +${state.settings.pointsPerCorrectAnswer}` : "残念！");
  elements.nextButton.hidden = false;

  state.resultTimerId = window.setTimeout(() => {
    state.resultTimerId = null;
    if (state.answerLocked) showQuestion();
  }, state.settings.resultDisplayMs);
}

function showMessage(text) {
  elements.message.textContent = text;
  elements.message.classList.add("show");
}

function hideMessage() {
  elements.message.classList.remove("show");
}

function drawScene(personBox, now) {
  const target = getDisplayRect();
  context.clearRect(0, 0, target.width, target.height);

  if (!personBox) {
    updateZoneSelection(null, now);
    return;
  }

  context.lineWidth = 4;
  context.strokeStyle = "#38bdf8";
  context.strokeRect(personBox.x, personBox.y, personBox.width, personBox.height);

  const scoreText = `${state.score} pt`;
  context.font = "800 24px system-ui";
  const metrics = context.measureText(scoreText);
  const paddingX = 12;
  const labelWidth = metrics.width + paddingX * 2;
  const labelHeight = 40;
  const labelX = Math.max(4, Math.min(target.width - labelWidth - 4, personBox.x + personBox.width / 2 - labelWidth / 2));
  const labelY = Math.max(4, personBox.y - labelHeight - 8);

  context.fillStyle = "rgba(3, 7, 18, 0.88)";
  context.fillRect(labelX, labelY, labelWidth, labelHeight);
  context.fillStyle = "#f8fafc";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(scoreText, labelX + labelWidth / 2, labelY + labelHeight / 2);

  const zoneIndex = zoneFromPerson(personBox);
  updateZoneSelection(zoneIndex, now);

  if (zoneIndex !== null && !state.answerLocked) {
    const progress = Math.min(1, (now - state.zoneEnteredAt) / state.settings.holdDurationMs);
    const choiceWidth = target.width / state.currentQuestion.choices.length;
    context.fillStyle = "rgba(248, 250, 252, 0.9)";
    context.fillRect(zoneIndex * choiceWidth, target.height - 8, choiceWidth * progress, 8);
  }
}

async function detectionLoop(now) {
  if (!state.running) return;

  if (state.model && elements.video.readyState >= 2 && now - state.lastDetectionAt >= state.detectionIntervalMs) {
    state.lastDetectionAt = now;
    try {
      const predictions = await state.model.detect(elements.video, 5, 0.45);
      const people = predictions
        .filter((prediction) => prediction.class === "person")
        .sort((a, b) => b.score - a.score);
      state.latestPerson = people.length > 0 ? predictionToDisplayBox(people[0]) : null;
    } catch (error) {
      console.error("Detection error", error);
    }
  }

  drawScene(state.latestPerson, performance.now());
  state.animationFrameId = requestAnimationFrame(detectionLoop);
}

async function startApp() {
  elements.startButton.disabled = true;
  elements.statusText.textContent = "モデルを読み込み中";

  try {
    if (state.questions.length === 0) await loadQuestions();
    if (!state.model) state.model = await cocoSsd.load({ base: "lite_mobilenet_v2" });

    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });

    elements.video.srcObject = state.stream;
    await elements.video.play();
    resizeCanvas();
    showQuestion();
    state.running = true;
    elements.startButton.hidden = true;
    state.animationFrameId = requestAnimationFrame(detectionLoop);
  } catch (error) {
    console.error(error);
    elements.statusText.textContent = "開始できませんでした";
    showMessage(error instanceof Error ? error.message : "カメラまたはモデルの初期化に失敗しました");
    elements.startButton.disabled = false;
  }
}

function resetScore() {
  state.score = 0;
  showMessage("スコアをリセットしました");
  window.setTimeout(hideMessage, 900);
}

function stopCamera() {
  state.running = false;
  if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
  state.stream?.getTracks().forEach((track) => track.stop());
}

elements.startButton.addEventListener("click", startApp);
elements.nextButton.addEventListener("click", showQuestion);
elements.resetButton.addEventListener("click", resetScore);
window.addEventListener("resize", resizeCanvas);
window.addEventListener("beforeunload", stopCamera);

loadQuestions().catch((error) => {
  console.error(error);
  elements.statusText.textContent = "問題データのエラー";
  showMessage(error.message);
});
