import {
  FilesetResolver,
  PoseLandmarker
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/+esm";

const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const CORE_LANDMARKS = [0, 11, 12, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const FOOT_LANDMARKS = [27, 28, 29, 30, 31, 32];
const HEAD_LANDMARKS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

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

const state = {
  phase: "game",
  poseLandmarker: null,
  stream: null,
  running: false,
  animationFrameId: null,
  lastVideoTime: -1,
  lastDetectionAt: 0,
  detectionIntervalMs: 85,
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
  elements.confirmGameButton.disabled = false;
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
    elements.gameSettingsStatus.textContent = `最大点数は問題数以上、100000以下の整数で指定してください。`;
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

async function createPoseLandmarker(delegate) {
  const vision = await FilesetResolver.forVisionTasks(WASM_URL);
  return PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      delegate
    },
    runningMode: "VIDEO",
    numPoses: 6,
    minPoseDetectionConfidence: 0.35,
    minPosePresenceConfidence: 0.35,
    minTrackingConfidence: 0.35,
    outputSegmentationMasks: false
  });
}

async function ensurePoseLandmarker() {
  if (state.poseLandmarker) return;
  try {
    state.poseLandmarker = await createPoseLandmarker("GPU");
  } catch (gpuError) {
    console.warn("GPU delegate unavailable; falling back to CPU", gpuError);
    state.poseLandmarker = await createPoseLandmarker("CPU");
  }
}

async function confirmCamera() {
  const deviceId = elements.cameraSelect.value;
  if (!deviceId) return;

  elements.confirmCameraButton.disabled = true;
  elements.cameraStatus.textContent = "選択したカメラと高精度姿勢モデルを準備しています…";

  try {
    await startSelectedCamera(deviceId);
    await ensurePoseLandmarker();
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
  state.lostPrompted = false;
  cancelCountdown();
  elements.confirmParticipantButton.disabled = true;
  elements.participantStatus.textContent = "姿勢を検出しています。表示された丸い番号をクリックしてください。";
  elements.questionCard.hidden = true;
  elements.choiceLabels.hidden = true;
  elements.quizControls.hidden = true;
  setSetupStep("participant");
}

function confirmParticipant() {
  const track = state.tracks.get(state.selectedCandidateId);
  if (!track || performance.now() - track.lastSeen > 1000) {
    elements.participantStatus.textContent = "選択した人物を確認できません。もう一度番号を選んでください。";
    state.selectedCandidateId = null;
    elements.confirmParticipantButton.disabled = true;
    return;
  }

  state.participantTrackId = track.id;
  state.participantProfile = {
    descriptor: [...track.descriptor],
    scale: track.scale,
    bodyHeight: track.bodyHeight
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
    renderedWidth: sourceWidth * scale,
    renderedHeight: sourceHeight * scale,
    scale,
    cropX: (sourceWidth * scale - target.width) / 2,
    cropY: (sourceHeight * scale - target.height) / 2
  };
}

function landmarkToDisplay(landmark, transform) {
  return {
    x: transform.target.width - (landmark.x * transform.renderedWidth - transform.cropX),
    y: landmark.y * transform.renderedHeight - transform.cropY,
    visibility: landmark.visibility ?? 1,
    presence: landmark.presence ?? 1
  };
}

function isVisible(landmark, threshold = 0.25) {
  return Boolean(landmark) && (landmark.visibility ?? 1) >= threshold && (landmark.presence ?? 1) >= threshold;
}

function averagePoints(points) {
  if (points.length === 0) return { x: 0, y: 0 };
  const total = points.reduce(
    (sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }),
    { x: 0, y: 0 }
  );
  return { x: total.x / points.length, y: total.y / points.length };
}

function distance2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

function makeDescriptor(worldLandmarks) {
  if (!worldLandmarks || worldLandmarks.length < 33) return [];
  const shoulderCenter = midpoint3(worldLandmarks[11], worldLandmarks[12]);
  const hipCenter = midpoint3(worldLandmarks[23], worldLandmarks[24]);
  const torso = Math.max(0.001, distance3(shoulderCenter, hipCenter));
  return [
    distance3(worldLandmarks[11], worldLandmarks[12]) / torso,
    distance3(worldLandmarks[23], worldLandmarks[24]) / torso,
    distance3(worldLandmarks[11], worldLandmarks[13]) / torso,
    distance3(worldLandmarks[12], worldLandmarks[14]) / torso,
    distance3(worldLandmarks[13], worldLandmarks[15]) / torso,
    distance3(worldLandmarks[14], worldLandmarks[16]) / torso,
    distance3(worldLandmarks[23], worldLandmarks[25]) / torso,
    distance3(worldLandmarks[24], worldLandmarks[26]) / torso,
    distance3(worldLandmarks[25], worldLandmarks[27]) / torso,
    distance3(worldLandmarks[26], worldLandmarks[28]) / torso
  ].map((value) => Number.isFinite(value) ? value : 0);
}

function midpoint3(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: ((a.z ?? 0) + (b.z ?? 0)) / 2
  };
}

function descriptorDistance(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0.45;
  const meanSquare = a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0) / a.length;
  return Math.sqrt(meanSquare);
}

function poseFromLandmarks(landmarks, worldLandmarks, transform) {
  if (!landmarks || landmarks.length < 33) return null;
  const display = landmarks.map((landmark) => landmarkToDisplay(landmark, transform));
  const visibleCore = CORE_LANDMARKS.map((index) => display[index]).filter((point) => isVisible(point));
  if (visibleCore.length < 5) return null;

  const shoulders = [display[11], display[12]].filter((point) => isVisible(point));
  const hips = [display[23], display[24]].filter((point) => isVisible(point));
  const centerPoints = [...shoulders, ...hips];
  const center = averagePoints(centerPoints.length >= 2 ? centerPoints : visibleCore);

  const visibleFeet = FOOT_LANDMARKS.map((index) => display[index]).filter((point) => isVisible(point, 0.18));
  const footCandidates = visibleFeet.length > 0 ? visibleFeet : visibleCore;
  const lowestY = Math.max(...footCandidates.map((point) => point.y));
  const nearLowest = footCandidates.filter((point) => point.y >= lowestY - 35);
  const foot = { x: averagePoints(nearLowest).x, y: lowestY };

  const visibleHead = HEAD_LANDMARKS.map((index) => display[index]).filter((point) => isVisible(point, 0.18));
  const head = visibleHead.length > 0
    ? { x: averagePoints(visibleHead).x, y: Math.min(...visibleHead.map((point) => point.y)) }
    : { x: center.x, y: Math.min(...visibleCore.map((point) => point.y)) };

  const xs = visibleCore.map((point) => point.x);
  const ys = visibleCore.map((point) => point.y);
  const width = Math.max(30, Math.max(...xs) - Math.min(...xs));
  const bodyHeight = Math.max(80, foot.y - head.y);
  const shoulderWidth = shoulders.length === 2 ? distance2(shoulders[0], shoulders[1]) : width;
  const hipWidth = hips.length === 2 ? distance2(hips[0], hips[1]) : width * 0.7;
  const scale = Math.max(40, (shoulderWidth + hipWidth + bodyHeight * 0.35) / 3);
  const quality = visibleCore.reduce((sum, point) => sum + Math.min(point.visibility, point.presence), 0) / visibleCore.length;

  return {
    center,
    foot,
    head,
    width,
    bodyHeight,
    scale,
    descriptor: makeDescriptor(worldLandmarks),
    quality,
    landmarks: display,
    lastSeen: performance.now()
  };
}

function updateTrack(track, pose, now) {
  const dt = Math.max(16, now - track.lastSeen);
  const measuredVelocity = {
    x: (pose.center.x - track.center.x) / dt,
    y: (pose.center.y - track.center.y) / dt
  };
  const alpha = 0.58;
  track.velocity = {
    x: track.velocity.x * 0.55 + measuredVelocity.x * 0.45,
    y: track.velocity.y * 0.55 + measuredVelocity.y * 0.45
  };
  track.center = blendPoint(track.center, pose.center, alpha);
  track.foot = blendPoint(track.foot, pose.foot, alpha);
  track.head = blendPoint(track.head, pose.head, alpha);
  track.scale = track.scale * (1 - alpha) + pose.scale * alpha;
  track.bodyHeight = track.bodyHeight * (1 - alpha) + pose.bodyHeight * alpha;
  track.width = track.width * (1 - alpha) + pose.width * alpha;
  track.descriptor = blendArray(track.descriptor, pose.descriptor, 0.28);
  track.quality = pose.quality;
  track.landmarks = pose.landmarks;
  track.lastSeen = now;
  track.missingSince = null;
}

function blendPoint(a, b, alpha) {
  return { x: a.x * (1 - alpha) + b.x * alpha, y: a.y * (1 - alpha) + b.y * alpha };
}

function blendArray(a, b, alpha) {
  if (!a?.length) return [...b];
  if (!b?.length || a.length !== b.length) return [...a];
  return a.map((value, index) => value * (1 - alpha) + b[index] * alpha);
}

function createTrack(pose, now) {
  const track = {
    id: state.nextTrackId++,
    center: { ...pose.center },
    foot: { ...pose.foot },
    head: { ...pose.head },
    scale: pose.scale,
    bodyHeight: pose.bodyHeight,
    width: pose.width,
    descriptor: [...pose.descriptor],
    quality: pose.quality,
    landmarks: pose.landmarks,
    velocity: { x: 0, y: 0 },
    lastSeen: now,
    missingSince: null
  };
  state.tracks.set(track.id, track);
  return track;
}

function trackMatchScore(track, pose, now, participantMode) {
  const target = getDisplayRect();
  const elapsed = Math.max(0, now - track.lastSeen);
  const predictionHorizon = Math.min(elapsed, 700);
  const predicted = {
    x: track.center.x + track.velocity.x * predictionHorizon,
    y: track.center.y + track.velocity.y * predictionHorizon
  };
  const diagonal = Math.hypot(target.width, target.height);
  const distance = distance2(predicted, pose.center);
  const allowedDistance = participantMode
    ? Math.min(diagonal * 0.4, Math.max(track.scale * 3.2, 130 + elapsed * 0.08))
    : Math.min(diagonal * 0.3, Math.max(track.scale * 2.4, 110));
  if (distance > allowedDistance) return -Infinity;

  const scaleRatio = pose.scale / Math.max(1, track.scale);
  if (scaleRatio < 0.42 || scaleRatio > 2.4) return -Infinity;
  const bodyHeightRatio = pose.bodyHeight / Math.max(1, track.bodyHeight);
  if (participantMode && (bodyHeightRatio < 0.48 || bodyHeightRatio > 2.1)) return -Infinity;

  const referenceDescriptor = participantMode && state.participantProfile?.descriptor?.length
    ? state.participantProfile.descriptor
    : track.descriptor;
  const shapeDistance = descriptorDistance(referenceDescriptor, pose.descriptor);
  if (participantMode && shapeDistance > 0.68) return -Infinity;
  if (!participantMode && shapeDistance > 1.0) return -Infinity;

  const distanceScore = 1 - distance / allowedDistance;
  const scaleScore = 1 - Math.min(1, Math.abs(Math.log(scaleRatio)));
  const heightScore = 1 - Math.min(1, Math.abs(Math.log(bodyHeightRatio)));
  const shapeScore = 1 - Math.min(1, shapeDistance / 0.68);
  const qualityScore = Math.min(1, pose.quality);
  return distanceScore * 4.2 + shapeScore * 2.4 + scaleScore * 1.2 + heightScore + qualityScore * 0.4;
}

function updateTracks(poses, now) {
  const unmatched = new Set(poses.map((_, index) => index));
  const participant = state.participantTrackId ? state.tracks.get(state.participantTrackId) : null;

  if (participant) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (const index of unmatched) {
      const score = trackMatchScore(participant, poses[index], now, true);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0 && bestScore > 1.15) {
      updateTrack(participant, poses[bestIndex], now);
      unmatched.delete(bestIndex);
    } else if (!participant.missingSince) {
      participant.missingSince = now;
    }
  }

  const otherTracks = [...state.tracks.values()]
    .filter((track) => track.id !== state.participantTrackId && now - track.lastSeen < 3000)
    .sort((a, b) => b.lastSeen - a.lastSeen);

  for (const track of otherTracks) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (const index of unmatched) {
      const score = trackMatchScore(track, poses[index], now, false);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0 && bestScore > 0.9) {
      updateTrack(track, poses[bestIndex], now);
      unmatched.delete(bestIndex);
    }
  }

  for (const index of unmatched) createTrack(poses[index], now);

  for (const [id, track] of state.tracks) {
    if (id !== state.participantTrackId && now - track.lastSeen > 3000) state.tracks.delete(id);
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
  const answerAreaTop = target.height * 0.66;
  if (track.foot.y < answerAreaTop || track.foot.x < 0 || track.foot.x > target.width) return null;
  const count = state.currentQuestion.choices.length;
  return Math.min(count - 1, Math.floor((track.foot.x / target.width) * count));
}

function updateParticipantAnswer(track, now) {
  if (state.answerLocked || state.phase !== "quiz") return;
  const zoneIndex = zoneFromTrack(track);
  const previousZone = state.currentZone;
  state.currentZone = zoneIndex;

  if (zoneIndex === null) {
    state.zoneEnteredAt = 0;
    elements.statusText.textContent = state.answerMode === "space"
      ? "回答エリアへ移動してからスペースを押してください"
      : "回答エリアへ移動してください";
    updateChoiceClasses();
    return;
  }

  if (state.answerMode === "space") {
    elements.statusText.textContent = state.countdownActive
      ? `${state.currentQuestion.choices[zoneIndex]} を選択中`
      : `${state.currentQuestion.choices[zoneIndex]} を選択中 — スペースで確定`;
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
  elements.statusText.textContent = correct ? "正解！" : "不正解";
  showMessage(correct ? `正解！ +${state.currentQuestionPoints}` : "残念！");
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
  if (!participant || performance.now() - participant.lastSeen > 1800) {
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
  elements.questionCard.hidden = true;
  elements.choiceLabels.hidden = true;
  elements.quizControls.hidden = true;
  elements.endScreen.hidden = true;
  setSetupStep("game");
}

function startSpaceCountdown() {
  if (state.answerMode !== "space" || state.phase !== "quiz" || state.answerLocked || state.countdownActive) return;
  const participant = state.tracks.get(state.participantTrackId);
  if (!participant || performance.now() - participant.lastSeen > 1400) {
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
        showMessage("回答エリアに参加者がいません");
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
    .filter((track) => now - track.lastSeen < 1200 && track.quality >= 0.25)
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
    elements.participantStatus.textContent = "姿勢が見つかりません。頭から足まで映る位置に立ってください。";
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
  context.arc(track.foot.x, Math.min(target.height - 10, track.foot.y), 8, 0, Math.PI * 2);
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

  if (missingFor > 1200 && state.phase === "quiz") {
    state.currentZone = null;
    state.zoneEnteredAt = 0;
    elements.statusText.textContent = "参加者を再取得しています…";
    updateChoiceClasses();
  }

  if (missingFor > 4500 && state.phase === "quiz" && !state.lostPrompted) {
    state.lostPrompted = true;
    showMessage("参加者を見失いました。再登録してください");
    scheduleHideMessage(1500);
    beginParticipantSelection(true);
  }
  return missingFor > 1200;
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

function processPoseResult(result, now) {
  const transform = getVideoTransform();
  if (!transform) return;
  const landmarks = result?.landmarks ?? [];
  const worldLandmarks = result?.worldLandmarks ?? [];
  const poses = landmarks
    .map((poseLandmarks, index) => poseFromLandmarks(poseLandmarks, worldLandmarks[index], transform))
    .filter(Boolean);
  updateTracks(poses, now);
}

function detectionLoop(now) {
  if (!state.running) return;

  if (
    state.poseLandmarker &&
    elements.video.readyState >= 2 &&
    elements.video.currentTime !== state.lastVideoTime &&
    now - state.lastDetectionAt >= state.detectionIntervalMs
  ) {
    state.lastDetectionAt = now;
    state.lastVideoTime = elements.video.currentTime;
    try {
      const result = state.poseLandmarker.detectForVideo(elements.video, now);
      processPoseResult(result, performance.now());
    } catch (error) {
      console.error("Pose detection error", error);
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
  state.poseLandmarker?.close?.();
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
elements.nextButton.addEventListener("click", showQuestion);
elements.finishGameButton.addEventListener("click", showEndScreen);
elements.restartButton.addEventListener("click", restartGame);
elements.returnToStartButton.addEventListener("click", returnToStart);
elements.fullscreenButton.addEventListener("click", toggleFullscreen);
document.addEventListener("fullscreenchange", handleFullscreenChange);
window.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLButtonElement) return;
  if (state.answerMode === "space" && state.phase === "quiz") {
    event.preventDefault();
    startSpaceCountdown();
  }
});
window.addEventListener("resize", resizeCanvas);
window.addEventListener("beforeunload", stopApp);

loadQuestions().catch((error) => {
  console.error(error);
  elements.gameSettingsStatus.textContent = error.message;
});
