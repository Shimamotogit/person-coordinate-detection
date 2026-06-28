import {
  ObjectDetector
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/+esm";

const FLOAT16_MODEL_SEGMENT = "/float16/";
const INT8_MODEL_SEGMENT = "/int8/";
const MIN_PERSON_SCORE = 0.18;
const UI_VISIBLE_SCORE = 0.31;

const originalCreateFromOptions = ObjectDetector.createFromOptions.bind(ObjectDetector);

function normalizeLabel(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

function isPersonCategory(category) {
  if (!category) return false;

  const categoryName = normalizeLabel(category.categoryName);
  const displayName = normalizeLabel(category.displayName);

  return category.index === 0 ||
    categoryName === "person" ||
    displayName === "person" ||
    categoryName === "人物" ||
    displayName === "人物" ||
    categoryName === "人" ||
    displayName === "人";
}

function extractPersonDetection(detection) {
  const personCategory = detection?.categories?.find(isPersonCategory);
  if (!personCategory) return null;

  return {
    ...detection,
    categories: [
      {
        ...personCategory,
        score: Math.max(Number(personCategory.score) || 0, UI_VISIBLE_SCORE)
      }
    ]
  };
}

function filterPersonResults(result) {
  const detections = Array.isArray(result?.detections) ? result.detections : [];
  return {
    ...result,
    detections: detections.map(extractPersonDetection).filter(Boolean)
  };
}

function createDetectorProxy(detector) {
  return new Proxy(detector, {
    get(target, property) {
      if (property === "detectForVideo") {
        return (...args) => filterPersonResults(target.detectForVideo(...args));
      }

      if (property === "detect") {
        return (...args) => filterPersonResults(target.detect(...args));
      }

      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

ObjectDetector.createFromOptions = async function createCompatibleDetector(wasmFileset, options = {}) {
  const {
    categoryAllowlist: _unusedAllowlist,
    ...optionsWithoutAllowlist
  } = options;

  const baseOptions = { ...(options.baseOptions ?? {}) };
  const modelAssetPath = String(baseOptions.modelAssetPath ?? "");

  // EfficientDet-Lite2 int8 はCPU向けです。GPUを使う場合は同じモデルの
  // float16版に切り替え、GPU初期化に失敗した場合は既存処理がCPUへ戻します。
  if (baseOptions.delegate === "GPU" && modelAssetPath.includes(INT8_MODEL_SEGMENT)) {
    baseOptions.modelAssetPath = modelAssetPath.replace(INT8_MODEL_SEGMENT, FLOAT16_MODEL_SEGMENT);
  }

  const requestedThreshold = Number(options.scoreThreshold);
  const scoreThreshold = Number.isFinite(requestedThreshold)
    ? Math.min(requestedThreshold, MIN_PERSON_SCORE)
    : MIN_PERSON_SCORE;

  const detector = await originalCreateFromOptions(wasmFileset, {
    ...optionsWithoutAllowlist,
    baseOptions,
    scoreThreshold
  });

  return createDetectorProxy(detector);
};

console.info("人物検出の互換修正を適用しました。人物カテゴリは推論後に判定します。");
