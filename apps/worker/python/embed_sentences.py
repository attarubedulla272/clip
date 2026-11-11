import argparse
import json
import os
import sys

from fastembed import TextEmbedding


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()

    payload = json.load(sys.stdin)
    sentences = payload.get("sentences") if isinstance(payload, dict) else None
    if not isinstance(sentences, list) or not all(isinstance(item, str) for item in sentences):
        raise ValueError("Embedding input must contain a list of sentence strings")
    if len(sentences) == 0:
        print(json.dumps({"type": "result", "embeddings": []}, allow_nan=False), flush=True)
        return

    os.makedirs(args.cache_dir, exist_ok=True)
    print("Downloading embedding model, first run only", file=sys.stderr, flush=True)
    model = TextEmbedding(
        model_name=args.model,
        cache_dir=args.cache_dir,
        threads=args.threads,
        providers=["CPUExecutionProvider"],
    )
    embeddings = []
    for index, embedding in enumerate(model.embed(sentences, batch_size=32), start=1):
        embeddings.append(embedding.tolist())
        if index % 32 == 0 or index == len(sentences):
            print(json.dumps({
                "type": "progress",
                "completed": index,
                "total": len(sentences),
            }), flush=True)

    print(json.dumps({"type": "result", "embeddings": embeddings}, allow_nan=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Sentence embedding failed: {error}", file=sys.stderr, flush=True)
        raise
