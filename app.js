import {
  FilesetResolver,
  ObjectDetector
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/+esm";

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite2/int8/1/efficientdet_lite2.tflite";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";

const elements = {
  stage: document.querySelector("#stage"),
  video: document.querySelector("#camera"),
  canvas: document.querySelector("#overlay"),
  setupPanel: document.querySelector("#setupPanel"),
  gameStep: document.querySelector("#gameStep"),
  cameraStep: document.querySelector("#cameraStep"),
  participantStep: document.querySelector("#participantStep"),
  answerStep: document.querySelector("#answerStep"),
  stepIndicators: [...document.querySelectorAll("[data-step]")],
  questionCountInput: document.querySelector("#questionCountInput"),
  maxScoreInput: document.querySelector("#maxScoreInput"),
  questionCountHelp: document.querySelector("#questionCountHelp"),
  gameSettingsStatus: document.querySelector("#gameSettingsStatus"),
  confirmGameButton: document.querySelector("#confirmGameButton"),
  scanCamerasButton: document.querySelector("#scanCamerasButton"),
  cameraSelect: document.querySelector("#cameraSelect"),
  confirmCameraButton: document.querySelector("#confirmCameraButton"),
  cameraStatus: document.querySelector("#cameraStatus"),
  backToGameButton: document.querySelector("#backToGameButton"),
  participantStatus: document.querySelector("#participantStatus"),
  confirmParticipantButton: document.querySelector("#confirmParticipantButton"),
  backToCameraButton: document.querySelector("#backToCameraButton"),
  backToParticipantButton: document.querySelector("#backToParticipantButton"),
  startQuizButton: document.querySelector("#startQuizButton"),
  holdDurationInput: document.querySelector("#holdDurationInput"),
  questionCard: document.querySelector("#questionCard"),
  questionText: document.querySelector("#questionText"),
  questionCounter: document.querySelector("#questionCounter"),
  scoreSummary: document.querySelector("#scoreSummary"),
  statusText: document.querySelector("#statusText"),
  choiceLabels: document.querySelector("#choiceLabels"),
  quizControls: document.querySelector("#quizControls"),
  fullscreenButton: document.querySelector("#fullscreenButton"),
  reselectParticipantButton: document.querySelector("#reselectParticipantButton"),
  nextButton: document.querySelector("#nextButton"),
  finishGameButton: document.querySelector("#finishGameButton"),
  endScreen: document.querySelector("#endScreen"),
  finalScore: document.querySelector("#finalScore"),
  finalMaxScore: document.querySelector("#finalMaxScore"),
  finalCorrectCount: document.querySelector("#finalCorrectCount"),
  restartButton: document.querySelector("#restartButton"),
  returnToStartButton: document.querySelector("#returnToStartButton"),
  message: document.querySelector("#message"),
  countdown: document.querySelector("#countdown")
};

const context = elements.canvas.getContext("2d");
const appearanceCanvas = document.createElement("canvas");
appearanceCanvas.width = 32;
appearanceCanvas.height = 48;
const appearanceContext = appearanceCanvas.getContext("2d", { willReadFrequently: true });

const state = {
  phase: "game",
  objectDetector: null,
  stream: null,
  running: false,
  animationFrameId: null,
  lastVideoTime: -1,
  lastDetectionAt: 0,
  detectionIntervalMs: 95,
  tracks: new Map(),
  nextTrackId: 1,
  markerHitAreas: [],
  selectedCandidateId: null,
  participantTrackId: null,
  participantProfile: null,
  resumeAfterRegistration: false,
  lostPrompted: false,
  questions: [],
  settings: {
    holdDurationMs: 1200,
    resultDisplayMs: 1300,
    spaceCountdownSeconds: 3,
    defaultQuestionCount: 5,
    defaultMaxScore: 500
  },
  game: {
    questionCount: 5,
    maxScore: 500,
    pointValues: [],
    answeredCount: 0,
    correctCount: 0
  },
  order: [],
  orderPosition: 0,
  currentQuestion: null,
  currentQuestionPoints: 0,
  score: 0,
  answerMode: "timer",
  currentZone: null,
  zoneEnteredAt: 0,
  answerLocked: false,
  awaitingNext: false,
  resultTimerId: null,
  messageTimerId: null,
  countdownTimerId: null,
  countdownActive: false
};

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
  const defaultCount = Math.min(state.questions.length, Math.max(1, Number(state.settings.defaultQuestionCount) || 5));
  const defaultMax = Math.max(defaultCount, Number(state.settings.defaultMaxScore) || defaultCount * 100);
  elements.questionCountInput.max = String(state.questions.length);
  elements.questionCountInput.value = String(defaultCount);
  elements.maxScoreInput.value = String(defaultMax);
  elements.maxScoreInput.min = String(defaultCount);
  elements.holdDurationInput.value = String(state.settings.holdDurationMs / 1000);
  elements.questionCountHelp.textContent = `1〜${state.questions.length}問から選択できます。`;
  validateGameSettings();
}

function setSetupStep(step) {
  state.phase = step;
  elements.setupPanel.hidden = false;
  elements.endScreen.hidden = true;
  elements.gameStep.hidden = step !== "game";
  elements.cameraStep.hidden = step !== "camera";
  elements.participantStep.hidden = step !== "participant";
  elements.answerStep.hidden = step !== "answer";
  elements.stepIndicators.forEach((item) => item.classList.toggle("active", item.dataset.step === step));
  elements.canvas.classList.toggle("selecting", step === "participant");
  elements.setupPanel.classList.toggle("participant-mode", step === "participant");
}

function validateGameSettings() {
  const questionCount = Number(elements.questionCountInput.value);
  const maxScore = Number(elements.maxScoreInput.value);
  const validCount = Number.isInteger(questionCount) && questionCount >= 1 && questionCount <= state.questions.length;
  const validScore = Number.isInteger(maxScore) && maxScore >= questionCount && maxScore <= 100000;
  elements.maxScoreInput.min = validCount ? String(questionCount) : "1";
  elements.confirmGameButton.disabled = !(validCount && validScore && state.questions.length > 0);

  if (!validCount && state.questions.length > 0) {
    elements.gameSettingsStatus.textContent = `問題数は1〜${state.questions.length}の整数で指定してください。`;
  } else if (!validScore) {
    elements.gameSettingsStatus.textContent = "最大点数は問題数以上、100000以下の整数で指定してください。";
  } else {
    const base = Math.floor(maxScore / questionCount);
    const remainder = maxScore % questionCount;
    elements.gameSettingsStatus.textContent = remainder === 0
      ? `1問あたり${base}点、全問正解で${maxScore}点です。`
      : `各問題へ${base}〜${base + 1}点を配分し、全問正解で${maxScore}点にします。`;
  }
  return validCount && validScore;
}

function confirmGameSettings() {
  if (!validateGameSettings()) return;
  state.game.questionCount = Number(elements.questionCountInput.value);
  state.game.maxScore = Number(elements.maxScoreInput.value);
  state.game.pointValues = distributePoints(state.game.maxScore, state.game.questionCount);
  setSetupStep("camera");
}

function distributePoints(maxScore, questionCount) {
  const base = Math.floor(maxScore / questionCount);
  const remainder = maxScore % questionCount;
  return Array.from({ length: questionCount }, (_, index) => base + (index < remainder ? 1 : 0));
}

async function scanCameras() {
  elements.scanCamerasButton.disabled = true;
  elements.cameraStatus.textContent = "カメラへのアクセス許可を確認しています…";
  try {
    const permissionStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    permissionStream.getTracks().forEach((track) => track.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === "videoinput");
    elements.cameraSelect.replaceChildren(new Option("カメラを選択してください", ""));
    cameras.forEach((camera, index) => {
      elements.cameraSelect.add(new Option(camera.label || `カメラ ${index + 1}`, camera.deviceId));
    });
    elements.cameraSelect.disabled = cameras.length === 0;
    elements.confirmCameraButton.disabled = true;
    elements.cameraStatus.textContent = cameras.length > 0
      ? `${cameras.length}台のカメラが見つかりました。使用するカメラを選択してください。`
      : "利用できるカメラが見つかりませんでした。";
  } catch (error) {
    console.error(error);
    elements.cameraStatus.textContent = "カメラの利用が許可されていないか、カメラを取得できませんでした。";
  } finally {
    elements.scanCamerasButton.disabled = false;
  }
}

async function startSelectedCamera(deviceId) {
  stopStream();
  clearTracking();
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 }
    },
    audio: false
  });
  elements.video.srcObject = state.stream;
  await elements.video.play();
  state.lastVideoTime = -1;
  resizeCanvas();
}

async function createObjectDetector(delegate) {
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  return ObjectDetector.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    maxResults: 8,
    scoreThreshold: 0.32,
    categoryAllowlist: ["person"]
  });
}

async function ensureObjectDetector() {
  if (state.objectDetector) return;
  try {
    state.objectDetector = await createObjectDetector("GPU");
  } catch (gpuError) {
    console.warn("GPU delegate unavailable; falling back to CPU", gpuError);
    state.objectDetector = await createObjectDetector("CPU");
  }
}

async function confirmCamera() {
  const deviceId = elements.cameraSelect.value;
  if (!deviceId) return;
  elements.confirmCameraButton.disabled = true;
  elements.cameraStatus.textContent = "選択したカメラと高精度人物検出モデルを準備しています…";
  try {
    await startSelectedCamera(deviceId);
    await ensureObjectDetector();
    if (!state.running) {
      state.running = true;
      state.animationFrameId = requestAnimationFrame(detectionLoop);
    }
    beginParticipantSelection(false);
  } catch (error) {
    console.error(error);
    elements.cameraStatus.textContent = error instanceof Error ? error.message : "カメラを開始できませんでした。";
    elements.confirmCameraButton.disabled = false;
  }
}

function beginParticipantSelection(resumeAfterRegistration) {
  state.resumeAfterRegistration = resumeAfterRegistration;
  state.selectedCandidateId = null;
  state.participantTrackId = null;
  state.participantProfile = null;
  state.currentZone = null;
  state.zoneEnteredAt = 0;
  state.answerLocked = true;
  state.awaitingNext = false;
  state.lostPrompted = false;
  cancelCountdown();
  elements.confirmParticipantButton.disabled = true;
  elements.participantStatus.textContent = "人物を検出しています。表示された丸い番号をクリックしてください。";
  elements.questionCard.hidden = true;
  elements.choiceLabels.hidden = true;
  elements.quizControls.hidden = true;
  setSetupStep("participant");
}

function confirmParticipant() {
  const track = state.tracks.get(state.selectedCandidateId);
  if (!track || performance.now() - track.lastSeen > 1100) {
    elements.participantStatus.textContent = "選択した人物を確認できません。もう一度番号を選んでください。";
    state.selectedCandidateId = null;
    elements.confirmParticipantButton.disabled = true;
    return;
  }
  state.participantTrackId = track.id;
  state.participantProfile = {
    appearance: [...track.appearance],
    aspectRatio: track.box.width / Math.max(1, track.box.height),
    area: track.box.width * track.box.height
  };
  state.lostPrompted = false;

  if (state.resumeAfterRegistration && state.currentQuestion) {
    state.phase = "quiz";
    elements.setupPanel.hidden = true;
    elements.questionCard.hidden = false;
    elements.choiceLabels.hidden = false;
    elements.quizControls.hidden = false;
    state.answerLocked = false;
    state.currentZone = null;
    state.zoneEnteredAt = 0;
    updateInstructionText();
  } else {
    setSetupStep("answer");
  }
}

function startQuiz() {
  const modeInput = document.querySelector('input[name="answerMode"]:checked');
  state.answerMode = modeInput?.value === "space" ? "space" : "timer";
  const seconds = Number(elements.holdDurationInput.value);
  state.settings.holdDurationMs = Number.isFinite(seconds)
    ? Math.max(500, Math.min(10000, seconds * 1000))
    : 1200;
  startNewGame();
}

function startNewGame() {
  state.resumeAfterRegistration = false;
  state.game.answeredCount = 0;
  state.game.correctCount = 0;
  state.score = 0;
  state.order = shuffle(state.questions.map((_, index) => index)).slice(0, state.game.questionCount);
  state.orderPosition = 0;
  state.currentQuestion = null;
  state.currentQuestionPoints = 0;
  state.awaitingNext = false;
  state.phase = "quiz";
  elements.setupPanel.hidden = true;
  elements.endScreen.hidden = true;
  elements.questionCard.hidden = false;
  elements.choiceLabels.hidden = false;
  elements.quizControls.hidden = false;
  showQuestion();
}

function showQuestion() {
  if (state.resultTimerId) {
    clearTimeout(state.resultTimerId);
    state.resultTimerId = null;
  }
  cancelCountdown();
  hideMessage();
  state.awaitingNext = false;

  if (state.game.answeredCount >= state.game.questionCount || state.orderPosition >= state.order.length) {
    showEndScreen();
    return;
  }

  state.currentQuestion = state.questions[state.order[state.orderPosition]];
  state.currentQuestionPoints = state.game.pointValues[state.orderPosition];
  state.orderPosition += 1;
  state.answerLocked = false;
  state.currentZone = null;
  state.zoneEnteredAt = 0;
  elements.nextButton.hidden = true;
  elements.questionText.textContent = state.currentQuestion.text;
  elements.questionCounter.textContent = `${state.orderPosition} / ${state.game.questionCount}`;
  updateScoreSummary();
  updateInstructionText();
  renderChoiceLabels();
}

function updateScoreSummary() {
  elements.scoreSummary.textContent = `${state.score} / ${state.game.maxScore} pt`;
}

function updateInstructionText() {
  elements.statusText.textContent = state.answerMode === "space"
    ? "回答位置へ移動し、管理者がスペースを押してください"
    : "回答位置へ移動してください";
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

function getVideoTransform() {
  const sourceWidth = elements.video.videoWidth;
  const sourceHeight = elements.video.videoHeight;
  const target = getDisplayRect();
  if (!sourceWidth || !sourceHeight) return null;
  const scale = Math.max(target.width / sourceWidth, target.height / sourceHeight);
  return {
    target,
    sourceWidth,
    sourceHeight,
    scale,
    renderedWidth: sourceWidth * scale,
    renderedHeight: sourceHeight * scale,
    cropX: (sourceWidth * scale - target.width) / 2,
    cropY: (sourceHeight * scale - target.height) / 2
  };
}

function detectionToCandidate(detection, transform) {
  const boundingBox = detection.boundingBox;
  const category = detection.categories?.[0];
  if (!boundingBox || !category) return null;
  const sourceBox = {
    x: Math.max(0, boundingBox.originX),
    y: Math.max(0, boundingBox.originY),
    width: Math.min(transform.sourceWidth - Math.max(0, boundingBox.originX), boundingBox.width),
    height: Math.min(transform.sourceHeight - Math.max(0, boundingBox.originY), boundingBox.height)
  };
  if (sourceBox.width < 12 || sourceBox.height < 20) return null;

  const box = {
    x: transform.target.width - (sourceBox.x * transform.scale - transform.cropX) - sourceBox.width * transform.scale,
    y: sourceBox.y * transform.scale - transform.cropY,
    width: sourceBox.width * transform.scale,
    height: sourceBox.height * transform.scale
  };
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return {
    box,
    sourceBox,
    center,
    head: { x: center.x, y: Math.max(8, box.y) },
    answerPoint: { x: center.x, y: Math.min(transform.target.height - 8, box.y + box.height) },
    score: category.score ?? 0,
    appearance: extractAppearance(sourceBox),
    lastSeen: performance.now()
  };
}

function extractAppearance(sourceBox) {
  try {
    appearanceContext.clearRect(0, 0, appearanceCanvas.width, appearanceCanvas.height);
    appearanceContext.drawImage(
      elements.video,
      sourceBox.x,
      sourceBox.y,
      sourceBox.width,
      sourceBox.height,
      0,
      0,
      appearanceCanvas.width,
      appearanceCanvas.height
    );
    const pixels = appearanceContext.getImageData(0, 0, appearanceCanvas.width, appearanceCanvas.height).data;
    const descriptor = [];
    const columns = 4;
    const rows = 4;
    const cellWidth = appearanceCanvas.width / columns;
    const cellHeight = appearanceCanvas.height / rows;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        let red = 0;
        let green = 0;
        let blue = 0;
        let count = 0;
        const startX = Math.floor(column * cellWidth);
        const endX = Math.floor((column + 1) * cellWidth);
        const startY = Math.floor(row * cellHeight);
        const endY = Math.floor((row + 1) * cellHeight);
        for (let y = startY; y < endY; y += 2) {
          for (let x = startX; x < endX; x += 2) {
            const offset = (y * appearanceCanvas.width + x) * 4;
            red += pixels[offset];
            green += pixels[offset + 1];
            blue += pixels[offset + 2];
            count += 1;
          }
        }
        descriptor.push(red / Math.max(1, count) / 255, green / Math.max(1, count) / 255, blue / Math.max(1, count) / 255);
      }
    }
    return descriptor;
  } catch (error) {
    console.warn("Appearance extraction failed", error);
    return [];
  }
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function intersectionOverUnion(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function appearanceDistance(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0.45;
  const meanSquare = a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0) / a.length;
  return Math.sqrt(meanSquare);
}

function blendPoint(a, b, alpha) {
  return { x: a.x * (1 - alpha) + b.x * alpha, y: a.y * (1 - alpha) + b.y * alpha };
}

function blendBox(a, b, alpha) {
  return {
    x: a.x * (1 - alpha) + b.x * alpha,
    y: a.y * (1 - alpha) + b.y * alpha,
    width: a.width * (1 - alpha) + b.width * alpha,
    height: a.height * (1 - alpha) + b.height * alpha
  };
}

function blendArray(a, b, alpha) {
  if (!a?.length) return [...b];
  if (!b?.length || a.length !== b.length) return [...a];
  return a.map((value, index) => value * (1 - alpha) + b[index] * alpha);
}

function createTrack(candidate, now) {
  const track = {
    id: state.nextTrackId++,
    box: { ...candidate.box },
    center: { ...candidate.center },
    head: { ...candidate.head },
    answerPoint: { ...candidate.answerPoint },
    appearance: [...candidate.appearance],
    score: candidate.score,
    velocity: { x: 0, y: 0 },
    lastSeen: now
  };
  state.tracks.set(track.id, track);
  return track;
}

function updateTrack(track, candidate, now) {
  const dt = Math.max(16, now - track.lastSeen);
  const measuredVelocity = {
    x: (candidate.center.x - track.center.x) / dt,
    y: (candidate.center.y - track.center.y) / dt
  };
  const alpha = 0.62;
  track.velocity = {
    x: track.velocity.x * 0.55 + measuredVelocity.x * 0.45,
    y: track.velocity.y * 0.55 + measuredVelocity.y * 0.45
  };
  track.box = blendBox(track.box, candidate.box, alpha);
  track.center = blendPoint(track.center, candidate.center, alpha);
  track.head = blendPoint(track.head, candidate.head, alpha);
  track.answerPoint = blendPoint(track.answerPoint, candidate.answerPoint, alpha);
  track.appearance = blendArray(track.appearance, candidate.appearance, 0.12);
  track.score = candidate.score;
  track.lastSeen = now;
}

function trackMatchScore(track, candidate, now, participantMode) {
  const target = getDisplayRect();
  const elapsed = Math.max(0, now - track.lastSeen);
  const horizon = Math.min(elapsed, 800);
  const predicted = {
    x: track.center.x + track.velocity.x * horizon,
    y: track.center.y + track.velocity.y * horizon
  };
  const diagonal = Math.hypot(target.width, target.height);
  const centerDistance = distance(predicted, candidate.center);
  const allowedDistance = participantMode
    ? Math.min(diagonal * 0.48, Math.max(track.box.width * 2.8, 150 + elapsed * 0.1))
    : Math.min(diagonal * 0.32, Math.max(track.box.width * 2.0, 120));
  if (centerDistance > allowedDistance) return -Infinity;

  const areaRatio = (candidate.box.width * candidate.box.height) / Math.max(1, track.box.width * track.box.height);
  if (participantMode && (areaRatio < 0.18 || areaRatio > 5.5)) return -Infinity;
  if (!participantMode && (areaRatio < 0.3 || areaRatio > 3.5)) return -Infinity;

  const profileAppearance = participantMode && state.participantProfile?.appearance?.length
    ? state.participantProfile.appearance
    : track.appearance;
  const colorDistance = appearanceDistance(profileAppearance, candidate.appearance);
  if (participantMode && colorDistance > 0.42) return -Infinity;
  if (!participantMode && colorDistance > 0.55) return -Infinity;

  const distanceScore = 1 - centerDistance / allowedDistance;
  const sizeScore = 1 - Math.min(1, Math.abs(Math.log(areaRatio)) / 1.6);
  const colorScore = 1 - Math.min(1, colorDistance / 0.42);
  const overlapScore = intersectionOverUnion(track.box, candidate.box);
  return distanceScore * 3.4 + colorScore * 3.0 + overlapScore * 2.0 + sizeScore + candidate.score * 0.5;
}

function updateTracks(candidates, now) {
  const unmatched = new Set(candidates.map((_, index) => index));
  const participant = state.participantTrackId ? state.tracks.get(state.participantTrackId) : null;

  if (participant) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (const index of unmatched) {
      const score = trackMatchScore(participant, candidates[index], now, true);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0 && bestScore > 1.1) {
      updateTrack(participant, candidates[bestIndex], now);
      unmatched.delete(bestIndex);
    }
  }

  const otherTracks = [...state.tracks.values()]
    .filter((track) => track.id !== state.participantTrackId && now - track.lastSeen < 3200)
    .sort((a, b) => b.lastSeen - a.lastSeen);

  for (const track of otherTracks) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (const index of unmatched) {
      const score = trackMatchScore(track, candidates[index], now, false);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0 && bestScore > 0.9) {
      updateTrack(track, candidates[bestIndex], now);
      unmatched.delete(bestIndex);
    }
  }

  for (const index of unmatched) createTrack(candidates[index], now);
  for (const [id, track] of state.tracks) {
    if (id !== state.participantTrackId && now - track.lastSeen > 3200) state.tracks.delete(id);
  }
}

function clearTracking() {
  state.tracks.clear();
  state.nextTrackId = 1;
  state.markerHitAreas = [];
  state.selectedCandidateId = null;
  state.participantTrackId = null;
  state.participantProfile = null;
}

function zoneFromTrack(track) {
  if (!state.currentQuestion) return null;
  const target = getDisplayRect();
  const x = track.answerPoint.x;
  if (x < 0 || x > target.width) return null;
  const count = state.currentQuestion.choices.length;
  return Math.min(count - 1, Math.floor((x / target.width) * count));
}

function updateParticipantAnswer(track, now) {
  if (state.answerLocked || state.phase !== "quiz") return;
  const zoneIndex = zoneFromTrack(track);
  const previousZone = state.currentZone;
  state.currentZone = zoneIndex;

  if (zoneIndex === null) {
    state.zoneEnteredAt = 0;
    elements.statusText.textContent = "参加者を画面内へ移動してください";
    updateChoiceClasses();
    return;
  }

  if (state.answerMode === "space") {
    elements.statusText.textContent = state.countdownActive
      ? `${state.currentQuestion.choices[zoneIndex]} を選択中`
      : `${state.currentQuestion.choices[zoneIndex]} を選択中 — スペースで回答`;
    updateChoiceClasses();
    return;
  }

  if (previousZone !== zoneIndex || state.zoneEnteredAt === 0) state.zoneEnteredAt = now;
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
    label.classList.toggle("active", !state.answerLocked && index === state.currentZone);
    label.classList.toggle("correct", result !== null && index === state.currentQuestion.correctIndex);
    label.classList.toggle("wrong", result !== null && !result && index === state.currentZone);
  });
}

function submitAnswer(selectedIndex) {
  if (state.answerLocked || selectedIndex === null) return;
  state.answerLocked = true;
  cancelCountdown();
  const correct = selectedIndex === state.currentQuestion.correctIndex;
  if (correct) {
    state.score += state.currentQuestionPoints;
    state.game.correctCount += 1;
  }
  state.game.answeredCount += 1;
  updateScoreSummary();
  updateChoiceClasses(correct);
  showMessage(correct ? `正解！ +${state.currentQuestionPoints}` : "残念！");

  if (state.answerMode === "space") {
    state.awaitingNext = true;
    elements.statusText.textContent = state.game.answeredCount >= state.game.questionCount
      ? "スペースを押すと結果画面へ進みます"
      : "スペースを押すと次の問題へ進みます";
    elements.nextButton.hidden = true;
    return;
  }

  elements.statusText.textContent = correct ? "正解！" : "不正解";
  elements.nextButton.hidden = false;
  state.resultTimerId = setTimeout(() => {
    state.resultTimerId = null;
    if (state.answerLocked && state.phase === "quiz") showQuestion();
  }, state.settings.resultDisplayMs);
}

function showEndScreen() {
  if (state.resultTimerId) clearTimeout(state.resultTimerId);
  state.resultTimerId = null;
  cancelCountdown();
  hideMessage();
  state.phase = "end";
  state.answerLocked = true;
  state.awaitingNext = false;
  elements.questionCard.hidden = true;
  elements.choiceLabels.hidden = true;
  elements.quizControls.hidden = true;
  elements.setupPanel.hidden = true;
  elements.finalScore.textContent = String(state.score);
  elements.finalMaxScore.textContent = `/ ${state.game.maxScore} pt`;
  elements.finalCorrectCount.textContent = `${state.game.questionCount}問中${state.game.correctCount}問正解`;
  elements.endScreen.hidden = false;
}

function restartGame() {
  const participant = state.tracks.get(state.participantTrackId);
  if (!participant || performance.now() - participant.lastSeen > 2200) {
    elements.endScreen.hidden = true;
    beginParticipantSelection(false);
    return;
  }
  startNewGame();
}

function returnToStart() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (state.resultTimerId) clearTimeout(state.resultTimerId);
  state.resultTimerId = null;
  cancelCountdown();
  stopStream();
  clearTracking();
  state.currentQuestion = null;
  state.awaitingNext = false;
  elements.questionCard.hidden = true;
  elements.choiceLabels.hidden = true;
  elements.quizControls.hidden = true;
  elements.endScreen.hidden = true;
  setSetupStep("game");
}

function startSpaceCountdown() {
  if (state.answerMode !== "space" || state.phase !== "quiz" || state.answerLocked || state.countdownActive) return;
  const participant = state.tracks.get(state.participantTrackId);
  if (!participant || performance.now() - participant.lastSeen > 1600) {
    showMessage("参加者を追跡できていません");
    scheduleHideMessage(1000);
    return;
  }

  state.countdownActive = true;
  const totalSeconds = Math.max(1, Number(state.settings.spaceCountdownSeconds) || 3);
  const deadline = performance.now() + totalSeconds * 1000;
  elements.countdown.hidden = false;

  const tick = () => {
    const remaining = Math.ceil((deadline - performance.now()) / 1000);
    elements.countdown.textContent = remaining > 0 ? String(remaining) : "0";
    if (remaining <= 0) {
      state.countdownTimerId = null;
      state.countdownActive = false;
      elements.countdown.hidden = true;
      if (state.currentZone === null) {
        showMessage("参加者を画面内で確認できません");
        scheduleHideMessage(1100);
      } else {
        submitAnswer(state.currentZone);
      }
      return;
    }
    state.countdownTimerId = setTimeout(tick, 80);
  };
  tick();
}

function cancelCountdown() {
  if (state.countdownTimerId) clearTimeout(state.countdownTimerId);
  state.countdownTimerId = null;
  state.countdownActive = false;
  elements.countdown.hidden = true;
}

function showMessage(text) {
  if (state.messageTimerId) clearTimeout(state.messageTimerId);
  elements.message.textContent = text;
  elements.message.classList.add("show");
}

function scheduleHideMessage(delay) {
  state.messageTimerId = setTimeout(() => {
    state.messageTimerId = null;
    hideMessage();
  }, delay);
}

function hideMessage() {
  elements.message.classList.remove("show");
}

function drawParticipantSelection(now) {
  state.markerHitAreas = [];
  const tracks = [...state.tracks.values()]
    .filter((track) => now - track.lastSeen < 1300 && track.score >= 0.3)
    .sort((a, b) => a.center.x - b.center.x);

  tracks.forEach((track, index) => {
    const markerX = track.head.x;
    const markerY = Math.max(38, track.head.y - 24);
    const selected = track.id === state.selectedCandidateId;
    const radius = selected ? 31 : 25;
    context.beginPath();
    context.arc(markerX, markerY, radius, 0, Math.PI * 2);
    context.fillStyle = selected ? "rgba(37, 99, 235, 0.97)" : "rgba(3, 7, 18, 0.9)";
    context.fill();
    context.lineWidth = selected ? 5 : 3;
    context.strokeStyle = selected ? "#f8fafc" : "#38bdf8";
    context.stroke();
    context.fillStyle = "#f8fafc";
    context.font = "900 22px system-ui";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(index + 1), markerX, markerY + 1);
    state.markerHitAreas.push({ trackId: track.id, x: markerX, y: markerY, radius: radius + 13 });
  });

  if (tracks.length === 0) {
    elements.participantStatus.textContent = "人物が見つかりません。上半身だけでも画面に入る位置へ移動してください。";
  } else if (state.selectedCandidateId === null) {
    elements.participantStatus.textContent = `${tracks.length}人を検出しました。参加者の丸い番号をクリックしてください。`;
  }
}

function drawParticipantLabel(track) {
  const target = getDisplayRect();
  const text = `参加者  ${state.score} / ${state.game.maxScore} pt`;
  context.font = "800 22px system-ui";
  const metrics = context.measureText(text);
  const width = metrics.width + 28;
  const height = 42;
  const x = Math.max(4, Math.min(target.width - width - 4, track.head.x - width / 2));
  const y = Math.max(5, track.head.y - height - 16);
  context.fillStyle = "rgba(3, 7, 18, 0.92)";
  context.beginPath();
  context.roundRect(x, y, width, height, 13);
  context.fill();
  context.strokeStyle = "#38bdf8";
  context.lineWidth = 2;
  context.stroke();
  context.fillStyle = "#f8fafc";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, x + width / 2, y + height / 2);

  context.beginPath();
  context.arc(track.answerPoint.x, Math.min(target.height - 10, track.answerPoint.y), 8, 0, Math.PI * 2);
  context.fillStyle = "#38bdf8";
  context.fill();
  context.strokeStyle = "#f8fafc";
  context.lineWidth = 2;
  context.stroke();
}

function handleParticipantLost(now) {
  const track = state.tracks.get(state.participantTrackId);
  if (!track) return true;
  const missingFor = now - track.lastSeen;
  if (missingFor > 1500 && state.phase === "quiz") {
    state.currentZone = null;
    state.zoneEnteredAt = 0;
    elements.statusText.textContent = "参加者を再取得しています…";
    updateChoiceClasses();
  }
  if (missingFor > 5200 && state.phase === "quiz" && !state.lostPrompted) {
    state.lostPrompted = true;
    showMessage("参加者を見失いました。再登録してください");
    scheduleHideMessage(1500);
    beginParticipantSelection(true);
  }
  return missingFor > 1500;
}

function drawScene(now) {
  const target = getDisplayRect();
  context.clearRect(0, 0, target.width, target.height);
  if (state.phase === "participant") {
    drawParticipantSelection(now);
    return;
  }
  if (state.phase !== "answer" && state.phase !== "quiz") return;
  const participant = state.tracks.get(state.participantTrackId);
  if (!participant || handleParticipantLost(now)) return;
  drawParticipantLabel(participant);
  if (state.phase === "quiz") updateParticipantAnswer(participant, now);
}

function processDetectionResult(result, now) {
  const transform = getVideoTransform();
  if (!transform) return;
  const candidates = (result?.detections ?? [])
    .map((detection) => detectionToCandidate(detection, transform))
    .filter(Boolean);
  updateTracks(candidates, now);
}

function detectionLoop(now) {
  if (!state.running) return;
  if (
    state.objectDetector &&
    elements.video.readyState >= 2 &&
    elements.video.currentTime !== state.lastVideoTime &&
    now - state.lastDetectionAt >= state.detectionIntervalMs
  ) {
    state.lastDetectionAt = now;
    state.lastVideoTime = elements.video.currentTime;
    try {
      const result = state.objectDetector.detectForVideo(elements.video, now);
      processDetectionResult(result, performance.now());
    } catch (error) {
      console.error("Object detection error", error);
    }
  }
  drawScene(performance.now());
  state.animationFrameId = requestAnimationFrame(detectionLoop);
}

function handleCanvasClick(event) {
  if (state.phase !== "participant") return;
  const rect = elements.canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = state.markerHitAreas.find((area) => Math.hypot(x - area.x, y - area.y) <= area.radius);
  if (!hit) return;
  state.selectedCandidateId = hit.trackId;
  elements.confirmParticipantButton.disabled = false;
  elements.participantStatus.textContent = "選択しました。問題なければ参加者を確定してください。";
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      if (!elements.stage.requestFullscreen) throw new Error("このブラウザは全画面表示に対応していません。");
      await elements.stage.requestFullscreen({ navigationUI: "hide" });
    }
  } catch (error) {
    showMessage(error instanceof Error ? error.message : "全画面表示を開始できませんでした。");
    scheduleHideMessage(1300);
  }
}

function handleFullscreenChange() {
  const active = document.fullscreenElement === elements.stage;
  document.body.classList.toggle("fullscreen-active", active);
  elements.fullscreenButton.textContent = active ? "全画面を終了" : "全画面表示";
  requestAnimationFrame(resizeCanvas);
}

function stopStream() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  elements.video.srcObject = null;
}

function stopApp() {
  state.running = false;
  if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
  cancelCountdown();
  stopStream();
  state.objectDetector?.close?.();
}

elements.questionCountInput.addEventListener("input", validateGameSettings);
elements.maxScoreInput.addEventListener("input", validateGameSettings);
elements.confirmGameButton.addEventListener("click", confirmGameSettings);
elements.scanCamerasButton.addEventListener("click", scanCameras);
elements.cameraSelect.addEventListener("change", () => {
  elements.confirmCameraButton.disabled = !elements.cameraSelect.value;
});
elements.confirmCameraButton.addEventListener("click", confirmCamera);
elements.backToGameButton.addEventListener("click", () => setSetupStep("game"));
elements.canvas.addEventListener("click", handleCanvasClick);
elements.confirmParticipantButton.addEventListener("click", confirmParticipant);
elements.backToCameraButton.addEventListener("click", () => {
  stopStream();
  clearTracking();
  setSetupStep("camera");
});
elements.backToParticipantButton.addEventListener("click", () => beginParticipantSelection(false));
elements.startQuizButton.addEventListener("click", startQuiz);
elements.reselectParticipantButton.addEventListener("click", () => beginParticipantSelection(true));
elements.nextButton.addEventListener("click", () => {
  if (state.answerMode !== "space") showQuestion();
});
elements.finishGameButton.addEventListener("click", showEndScreen);
elements.restartButton.addEventListener("click", restartGame);
elements.returnToStartButton.addEventListener("click", returnToStart);
elements.fullscreenButton.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", handleFullscreenChange);
window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLButtonElement) return;
  if (state.answerMode !== "space" || state.phase !== "quiz") return;
  event.preventDefault();
  if (state.answerLocked && state.awaitingNext) {
    showQuestion();
  } else if (!state.answerLocked) {
    startSpaceCountdown();
  }
});
window.addEventListener("resize", resizeCanvas);
window.addEventListener("beforeunload", stopApp);

loadQuestions().catch((error) => {
  console.error(error);
  elements.gameSettingsStatus.textContent = error.message;
});
