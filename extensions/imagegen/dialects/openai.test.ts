import assert from "node:assert/strict";
import test from "node:test";
import { openai, PRESET_SIZES } from "./openai.ts";

test("openai dialect owns the OpenAI size rules", () => {
	for (const size of ["auto", ...PRESET_SIZES, "1536x1024", "2880x2880"]) {
		assert.equal(openai.validateSize(size), undefined, size);
	}
	assert.match(openai.validateSize("1000x1000") ?? "", /multiples of 16/);
	assert.match(openai.validateSize("3840x1152") ?? "", /3:1 aspect ratio/);
	assert.match(openai.validateSize("512x512") ?? "", /below/);
	assert.match(openai.validateSize("3840x2304") ?? "", /exceeds/);
	assert.match(openai.validateSize("bogus") ?? "", /must be/);
});

test("openai dialect declares its own arguments and reference cap", () => {
	assert.deepEqual([...openai.arguments], ["quality", "background", "compression", "moderation", "complexity"]);
	assert.equal(openai.maxReferenceImages, 16);
	assert.equal(openai.hasQuality, true);
	assert.ok(openai.describeSize().includes("multiples of 16"));
	assert.ok(openai.describeFeatures().join(" ").includes("OpenAI image API"));
});

test("openai dialect serializes generations as JSON and edits as multipart", () => {
	const generation = openai.build({ model: "m", prompt: "p", size: "1024x1024", quality: "high" });
	assert.equal(generation.multipart, false);
	assert.deepEqual(generation.body, { model: "m", prompt: "p", size: "1024x1024", quality: "high" });

	const edit = openai.build({
		model: "m",
		prompt: "p",
		images: [{ data: new Uint8Array([1, 2, 3]), mimeType: "image/png", filename: "ref.png" }],
	});
	assert.equal(edit.multipart, true);
	assert.ok(edit.body instanceof FormData);
	assert.ok((edit.body as FormData).has("image"));
});

test("openai dialect rejects argument pairs its API cannot combine", () => {
	assert.match(openai.checkArguments?.({ outputFormat: "png", compression: 50 }) ?? "", /compression requires/);
	assert.match(openai.checkArguments?.({ outputFormat: "jpeg", background: "transparent" }) ?? "", /transparent background/);
	assert.equal(openai.checkArguments?.({ outputFormat: "webp", background: "transparent", compression: 50 }), undefined);
});
