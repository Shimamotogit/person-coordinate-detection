"use strict";

const elements = {
  video: document.querySelector("#camera"),
  canvas: document.querySelector("#overlay"),
  setupPanel: document.querySelector("#setupPanel"),
  cameraStep: document.querySelector("#cameraStep"),
  participantStep: document.querySelector("#participantStep"),
  answerStep: document.querySelector("#answerStep"),
  stepIndicators: [...document.querySelectorAll("[data-step]")],
  scanCamerasButton: document.querySelector("#scanCamerasButton"),
  cameraSelect: document.querySelector("#cameraSelect"),
  confirmCameraButton: document.querySelector("#confirmCameraButton"),
  cameraStatus: document.querySelector("#cameraStatus"),
  participantStatus: document.querySelector("#participantStatus"),
  confirmParticipantButton: document.querySelector("#confirmParticipantButton"),
  backToCameraButton: document.querySelector("#backToCameraButton"),
  backToParticipantButton: document.querySelector("#backToParticipantButton"),
  startQuizButton: document.querySelector("#startQuizButton"),
  holdDurationInput: document.querySelector("#holdDurationInput"),
  questionCard: document.querySelector("#questionCard"),
  questionText: document.querySelector("#questionText"),
  questionCounter: document.querySelector("#questionCounter"),
  statusText: document.querySelector("#statusText"),
  choiceLabels: document.querySelector("#choiceLabels"),
  quizControls: document.querySelector("#quizControls"),
  reselectParticipantButton: document.querySelector("#reselectParticipantButton"),
  nextButton: document.querySelector("#nextButton"),
  resetButton: document.querySelector("#resetButton"),
  message: document.querySelector("#message"),
  countdown: document.querySelector("#countdown")
};

const context = elements.canvas.getContext("2d");

const state = {
  phase: "camera",
  model: null,
  stream: null,
  running: false,
  animationFrameId: null,
  lastDetectionAt: 0,
  detectionIntervalMs: 110,
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
    pointsPerCorrectAnswer: 100,
    holdDurationMs: 1200,
    resultDisplayMs: 1300,
    spaceCountdownSeconds: 3
  },
  order: [],
  orderPosition: 0,
  currentQuestion: null,
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
  elements.holdDurationInput.value = String(state.settings.holdDurationMs / 1000);
  resetQuestionOrder();
}

function resetQuestionOrder() {
  state.order = shuffle(state.questions.map((_, index) => index));
  state.orderPosition = 0;
}

function setSetupStep(step) {
  state.phase = step;
  elements.setupPanel.hidden = false;
  elements.cameraStep.hidden = step !== "camera";
  elements.participantStep.hidden = step !== "participant";
  elements.answerStep.hidden = step !== "answer";
  elements.stepIndicators.forEach((item) => item.classList.toggle("active", item.dataset.step === step));
  elements.canvas.classList.toggle("selecting", step === "participant");
  elements.setupPanel.classList.toggle("participant-mode", step === "participant");
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
      height: { ideal: 720 }
    },
    audio: false
  });

  elements.video.srcObject = state.stream;
  await elements.video.play();
  resizeCanvas();
}

async function confirmCamera() {
  const deviceId = elements.cameraSelect.value;
  if (!deviceId) return;

  elements.confirmCameraButton.disabled = true;
  elements.cameraStatus.textContent = "選択したカメラと人物検出モデルを準備しています…";

  try {
    await startSelectedCamera(deviceId);
    if (!state.model) state.model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
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
  elements.participantStatus.textContent = "人物を検出しています。表示された丸い番号をクリックしてください。";
  elements.questionCard.hidden = true;
  elements.choiceLabels.hidden = true;
  elements.quizControls.hidden = true;
  setSetupStep("participant");
}

function confirmParticipant() {
  const track = state.tracks.get(state.selectedCandidateId);
  if (!track || performance.now() - track.lastSeen > 700) {
    elements.participantStatus.textContent = "選択した人物を確認できません。もう一度番号を選んでください。";
    state.selectedCandidateId = null;
    elements.confirmParticipantButton.disabled = true;
    return;
  }

  state.participantTrackId = track.id;
  state.participantProfile = {
    area: track.box.width * track.box.height,
    aspectRatio: track.box.width / Math.max(1, track.box.height)
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
    elements.statusText.textContent = state.answerMode === "space"
      ? "回答位置へ移動し、管理者がスペースを押してください"
      : "回答位置へ移動してください";
  } else {
    setSetupStep("answer");
  }
}

function startQuiz() {
  const modeInput = document.querySelector('input[name="answerMode"]:checked');
  state.answerMode = modeInput?.value === "space" ? "space" : "timer";
  const seconds = Number(elements.holdDurationInput.value);
  state.settings.holdDurationMs = Number.isFinite(seconds) ? Math.max(500, Math.min(10000, seconds * 1000)) : 1200;
  state.resumeAfterRegistration = false;
  state.phase = "quiz";
  elements.setupPanel.hidden = true;
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

  if (state.orderPosition >= state.order.length) resetQuestionOrder();
  state.currentQuestion = state.questions[state.order[state.orderPosition]];
  state.orderPosition += 1;
  state.answerLocked = false;
  state.currentZone = null;
  state.zoneEnteredAt = 0;
  elements.nextButton.hidden = true;
  elements.questionText.textContent = state.currentQuestion.text;
  elements.questionCounter.textContent = `${state.orderPosition} / ${state.order.length}`;
  elements.statusText.textContent = state.answerMode === "space"
    ? "回答位置へ移動し、管理者がスペースを押してください"
    : "回答位置へ移動してください";
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
  if (!sourceWidth || !sourceHeight) return null;

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

function boxCenter(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
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

function candidateScore(track, box, strictSelected) {
  const previousCenter = boxCenter(track.box);
  const nextCenter = boxCenter(box);
  const distance = Math.hypot(nextCenter.x - previousCenter.x, nextCenter.y - previousCenter.y);
  const distanceLimit = strictSelected
    ? Math.max(90, track.box.width * 0.85)
    : Math.max(150, track.box.width * 1.5);
  const areaRatio = (box.width * box.height) / Math.max(1, track.box.width * track.box.height);
  const iou = intersectionOverUnion(track.box, box);

  if (distance > distanceLimit) return -Infinity;
  if (strictSelected && (areaRatio < 0.52 || areaRatio > 1.9)) return -Infinity;
  if (!strictSelected && (areaRatio < 0.3 || areaRatio > 3.2)) return -Infinity;

  if (strictSelected && state.participantProfile) {
    const profileAreaRatio = (box.width * box.height) / Math.max(1, state.participantProfile.area);
    const aspectRatio = box.width / Math.max(1, box.height);
    const aspectDifference = Math.abs(aspectRatio - state.participantProfile.aspectRatio);
    if (profileAreaRatio < 0.42 || profileAreaRatio > 2.4 || aspectDifference > 0.42) return -Infinity;
  }

  const distanceScore = 1 - distance / distanceLimit;
  const sizeScore = 1 - Math.min(1, Math.abs(Math.log(areaRatio)));
  return iou * 2.4 + distanceScore * 1.4 + sizeScore * 0.8;
}

function updateTrack(track, box, now) {
  const alpha = 0.68;
  track.box = {
    x: track.box.x * (1 - alpha) + box.x * alpha,
    y: track.box.y * (1 - alpha) + box.y * alpha,
    width: track.box.width * (1 - alpha) + box.width * alpha,
    height: track.box.height * (1 - alpha) + box.height * alpha
  };
  track.lastSeen = now;
}

function updateTracks(detections, now) {
  const unmatchedDetectionIndexes = new Set(detections.map((_, index) => index));
  const activeTracks = [...state.tracks.values()].filter((track) => now - track.lastSeen < 2600);

  const selectedTrack = state.participantTrackId ? state.tracks.get(state.participantTrackId) : null;
  if (selectedTrack && now - selectedTrack.lastSeen < 650) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    detections.forEach((box, index) => {
      const score = candidateScore(selectedTrack, box, true);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0 && bestScore > 0.35) {
      updateTrack(selectedTrack, detections[bestIndex], now);
      unmatchedDetectionIndexes.delete(bestIndex);
    }
  }

  const otherTracks = activeTracks.filter((track) => track.id !== state.participantTrackId);
  for (const track of otherTracks) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (const index of unmatchedDetectionIndexes) {
      const score = candidateScore(track, detections[index], false);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0 && bestScore > 0.15) {
      updateTrack(track, detections[bestIndex], now);
      unmatchedDetectionIndexes.delete(bestIndex);
    }
  }

  for (const index of unmatchedDetectionIndexes) {
    const track = { id: state.nextTrackId++, box: detections[index], lastSeen: now };
    state.tracks.set(track.id, track);
  }

  for (const [id, track] of state.tracks) {
    const keepSelected = id === state.participantTrackId;
    if (!keepSelected && now - track.lastSeen > 2600) state.tracks.delete(id);
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

function updateParticipantAnswer(track, now) {
  if (state.answerLocked || state.phase !== "quiz") return;
  const zoneIndex = zoneFromPerson(track.box);
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

  if (previousZone !== zoneIndex || state.zoneEnteredAt === 0) {
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
  if (correct) state.score += state.settings.pointsPerCorrectAnswer;

  updateChoiceClasses(correct);
  elements.statusText.textContent = correct ? "正解！" : "不正解";
  showMessage(correct ? `正解！ +${state.settings.pointsPerCorrectAnswer}` : "残念！");
  elements.nextButton.hidden = false;

  state.resultTimerId = setTimeout(() => {
    state.resultTimerId = null;
    if (state.answerLocked && state.phase === "quiz") showQuestion();
  }, state.settings.resultDisplayMs);
}

function startSpaceCountdown() {
  if (state.answerMode !== "space" || state.phase !== "quiz" || state.answerLocked || state.countdownActive) return;
  const participant = state.tracks.get(state.participantTrackId);
  if (!participant || performance.now() - participant.lastSeen > 700) {
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
    .filter((track) => now - track.lastSeen < 650)
    .sort((a, b) => a.box.x - b.box.x);

  tracks.forEach((track, index) => {
    const centerX = track.box.x + track.box.width / 2;
    const markerY = Math.max(38, track.box.y - 18);
    const selected = track.id === state.selectedCandidateId;
    const radius = selected ? 30 : 25;

    context.beginPath();
    context.arc(centerX, markerY, radius, 0, Math.PI * 2);
    context.fillStyle = selected ? "rgba(37, 99, 235, 0.96)" : "rgba(3, 7, 18, 0.88)";
    context.fill();
    context.lineWidth = selected ? 5 : 3;
    context.strokeStyle = selected ? "#f8fafc" : "#38bdf8";
    context.stroke();
    context.fillStyle = "#f8fafc";
    context.font = "900 22px system-ui";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(index + 1), centerX, markerY + 1);

    state.markerHitAreas.push({ trackId: track.id, x: centerX, y: markerY, radius: radius + 12 });
  });

  if (tracks.length === 0) {
    elements.participantStatus.textContent = "人物が見つかりません。全身が映る位置に立ってください。";
  } else if (state.selectedCandidateId === null) {
    elements.participantStatus.textContent = `${tracks.length}人を検出しました。参加者の丸い番号をクリックしてください。`;
  }
}

function drawParticipantLabel(track) {
  const target = getDisplayRect();
  const text = `参加者  ${state.score} pt`;
  context.font = "800 23px system-ui";
  const metrics = context.measureText(text);
  const width = metrics.width + 28;
  const height = 42;
  const x = Math.max(4, Math.min(target.width - width - 4, track.box.x + track.box.width / 2 - width / 2));
  const y = Math.max(5, track.box.y - height - 10);

  context.fillStyle = "rgba(3, 7, 18, 0.9)";
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

  const footX = track.box.x + track.box.width / 2;
  const footY = Math.min(target.height - 10, track.box.y + track.box.height);
  context.beginPath();
  context.arc(footX, footY, 8, 0, Math.PI * 2);
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

  if (missingFor > 750 && state.phase === "quiz") {
    state.currentZone = null;
    state.zoneEnteredAt = 0;
    elements.statusText.textContent = "登録した参加者を追跡しています…";
    updateChoiceClasses();
  }

  if (missingFor > 2200 && state.phase === "quiz" && !state.lostPrompted) {
    state.lostPrompted = true;
    showMessage("参加者を見失いました。再登録してください");
    scheduleHideMessage(1400);
    beginParticipantSelection(true);
  }
  return missingFor > 750;
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

async function detectionLoop(now) {
  if (!state.running) return;

  if (state.model && elements.video.readyState >= 2 && now - state.lastDetectionAt >= state.detectionIntervalMs) {
    state.lastDetectionAt = now;
    try {
      const predictions = await state.model.detect(elements.video, 10, 0.45);
      const detections = predictions
        .filter((prediction) => prediction.class === "person")
        .map(predictionToDisplayBox)
        .filter(Boolean);
      updateTracks(detections, performance.now());
    } catch (error) {
      console.error("Detection error", error);
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
  elements.participantStatus.textContent = "選択しました。問題なければ「この人を参加者に決定」を押してください。";
}

function resetScore() {
  state.score = 0;
  showMessage("スコアをリセットしました");
  scheduleHideMessage(900);
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
}

elements.scanCamerasButton.addEventListener("click", scanCameras);
elements.cameraSelect.addEventListener("change", () => {
  elements.confirmCameraButton.disabled = !elements.cameraSelect.value;
});
elements.confirmCameraButton.addEventListener("click", confirmCamera);
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
elements.resetButton.addEventListener("click", resetScore);
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
  elements.cameraStatus.textContent = error.message;
});
