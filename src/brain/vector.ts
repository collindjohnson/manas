export function normalizeVector(vector: number[]): Float32Array {
	if (!vector.length || vector.some((value) => !Number.isFinite(value)))
		throw new Error("embedding vector must contain finite values");
	const magnitude = Math.sqrt(
		vector.reduce((sum, value) => sum + value * value, 0),
	);
	if (!Number.isFinite(magnitude) || magnitude === 0)
		throw new Error("embedding vector must have non-zero magnitude");
	return Float32Array.from(vector, (value) => value / magnitude);
}

export function serializeVector(vector: Float32Array): Uint8Array {
	return new Uint8Array(
		vector.buffer.slice(
			vector.byteOffset,
			vector.byteOffset + vector.byteLength,
		),
	);
}

export function deserializeVector(
	value: Uint8Array,
	dimensions: number,
): Float32Array {
	if (value.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT)
		throw new Error("embedding vector dimensions do not match stored bytes");
	const copy = value.slice();
	const vector = new Float32Array(copy.buffer, copy.byteOffset, dimensions);
	if ([...vector].some((item) => !Number.isFinite(item)))
		throw new Error("stored embedding vector contains non-finite values");
	return vector;
}

export function cosineSimilarity(
	left: Float32Array,
	right: Float32Array,
): number {
	if (left.length !== right.length || left.length === 0)
		throw new Error("vectors must have equal non-zero dimensions");
	let dot = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;
	for (let index = 0; index < left.length; index += 1) {
		dot += left[index] * right[index];
		leftMagnitude += left[index] ** 2;
		rightMagnitude += right[index] ** 2;
	}
	if (!leftMagnitude || !rightMagnitude)
		throw new Error("vectors must have non-zero magnitude");
	return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}
