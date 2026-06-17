#!/usr/bin/env python3
import json
import os
import pickle
import sys
from datetime import datetime, timezone

from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor

LABELS = ["strong down", "down", "flat", "up", "strong up"]


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def vectorize(features, keys):
    return [float((features or {}).get(key, 0.0) or 0.0) for key in keys]


def predict_from_artifact(payload):
    artifact_path = payload.get("artifactPath") or payload.get("artifact_path")
    features = payload.get("features") or {}
    if not artifact_path or not os.path.exists(artifact_path):
      raise RuntimeError("artifact missing")
    with open(artifact_path, "rb") as fh:
      artifact = pickle.load(fh)
    keys = artifact["feature_keys"]
    classifier = artifact["classifier"]
    regressor = artifact["regressor"]
    vector = [vectorize(features, keys)]
    probabilities = classifier.predict_proba(vector)[0]
    classes = list(classifier.classes_)
    probs = [0.0] * len(LABELS)
    for index, klass in enumerate(classes):
      probs[int(klass)] = round(float(probabilities[index]), 4)
    expected_move = round(float(regressor.predict(vector)[0]), 4)
    top_index = max(range(len(probs)), key=lambda idx: probs[idx])
    return {
      "predicted_direction": LABELS[top_index],
      "expected_move_pct": expected_move,
      "direction_probabilities": probs,
      "sample_count": int(artifact.get("sample_count", 0)),
    }


def train_models(payload):
    rows = payload.get("trainingRows") or payload.get("training_rows") or []
    artifact_dir = payload.get("artifactDir") or payload.get("artifact_dir")
    horizons = payload.get("horizons") or [5, 15, 30]
    os.makedirs(artifact_dir, exist_ok=True)
    result = {
      "updatedAt": now_iso(),
      "horizons": {},
    }
    for minutes in horizons:
      key = f"{minutes}m"
      filtered = []
      for row in rows:
        outcome = ((row.get("outcomes") or {}).get(key) or {})
        if outcome.get("available") and outcome.get("direction") in LABELS:
          filtered.append((row.get("features") or {}, outcome))
      if len(filtered) < 8:
        result["horizons"][key] = {
          "sampleCount": len(filtered),
          "artifactPath": os.path.join(artifact_dir, f"truth-social-gold-{key}.pkl"),
          "trainedAt": now_iso(),
          "accuracy": None,
          "meanAbsError": None,
        }
        continue

      feature_keys = sorted({k for features, _ in filtered for k in features.keys()})
      x = [vectorize(features, feature_keys) for features, _ in filtered]
      y_class = [LABELS.index(outcome.get("direction")) for _, outcome in filtered]
      y_reg = [float(outcome.get("realizedPct") or 0.0) for _, outcome in filtered]

      classifier = RandomForestClassifier(
        n_estimators=160,
        max_depth=7,
        min_samples_leaf=2,
        random_state=7,
      )
      classifier.fit(x, y_class)
      class_preds = classifier.predict(x)
      accuracy = sum(1 for actual, pred in zip(y_class, class_preds) if actual == pred) / len(y_class)

      regressor = RandomForestRegressor(
        n_estimators=160,
        max_depth=7,
        min_samples_leaf=2,
        random_state=7,
      )
      regressor.fit(x, y_reg)
      reg_preds = regressor.predict(x)
      mae = sum(abs(actual - pred) for actual, pred in zip(y_reg, reg_preds)) / len(y_reg)

      artifact_path = os.path.join(artifact_dir, f"truth-social-gold-{key}.pkl")
      with open(artifact_path, "wb") as fh:
        pickle.dump({
          "feature_keys": feature_keys,
          "classifier": classifier,
          "regressor": regressor,
          "sample_count": len(filtered),
          "trained_at": now_iso(),
          "horizon": key,
        }, fh)

      result["horizons"][key] = {
        "sampleCount": len(filtered),
        "artifactPath": artifact_path,
        "trainedAt": now_iso(),
        "accuracy": round(float(accuracy), 4),
        "meanAbsError": round(float(mae), 4),
      }
    return result


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "predict"
    payload = json.load(sys.stdin)
    if mode == "train":
      print(json.dumps(train_models(payload)))
      return
    if mode == "predict":
      print(json.dumps(predict_from_artifact(payload)))
      return
    raise RuntimeError(f"unsupported mode: {mode}")


if __name__ == "__main__":
    main()
