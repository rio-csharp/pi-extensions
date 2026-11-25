import assert from "node:assert/strict";
import test from "node:test";
import { SENSENOVA_MAX_REFERENCE_IMAGES, SENSENOVA_PRESET_SIZES, sensenova } from "./sensenova.ts";

test("sensenova dialect owns the SenseNova size rules", () => {
	for (const size of ["auto", ...SENSENOVA_PRESET_SIZES, "512x512"]) {
		assert.equal(sensenova.validateSize(size), undefined, size);
	}
	assert.match(sensenova.validateSize("1000x1000") ?? "", /multiples of 32/);
	assert.match(sensenova.validateSize("256x256") ?? "", /at least 512px/);
	assert.match(sensenova.validateSize("4128x4128") ?? "", /4096px maximum edge/);
	assert.match(sensenova.validateSize("4096x1024") ?? "", /3:1 aspect ratio/);
	assert.match(sensenova.validateSize("bogus") ?? "", /must be/);
});

test("sensenova dialect declares its own arguments and reference cap", () => {
	assert.deepEqual([...sensenova.arguments], ["watermark", "promptExtend", "selfCorrection"]);
	assert.equal(sensenova.maxReferenceImages, SENSENOVA_MAX_REFERENCE_IMAGES);
	// No quality knob, so result headers and render calls skip it.
	assert.equal(sensenova.hasQuality, false);
	// The OpenAI-only pair checks do not apply here.
	assert.equal(sensenova.checkArguments, undefined);
	assert.ok(sensenova.describeFeatures().join(" ").includes("ignore quality"));
});

test("sensenova dialect always posts JSON and inlines references as data URLs", () => {
	const generation = sensenova.build({ model: "sensenova-u1.6-lite", prompt: "p", size: "2048x2048" });
	assert.equal(generation.multipart, false);
	assert.deepEqual(generation.body, {
		model: "sensenova-u1.6-lite",
		prompt: "p",
		n: 1,
		response_format: "b64_json",
		size: "2048x2048",
		watermark: false,
	});

	const edit = sensenova.build({
		model: "sensenova-u1.6-lite",
		prompt: "p",
		watermark: true,
		images: [{ data: new Uint8Array([1, 2, 3]), mimeType: "image/png", filename: "ref.png" }],
	});
	assert.equal(edit.multipart, false);
	const images = (edit.body as { images: { image_url: string }[] }).images;
	assert.equal(images.length, 1);
	assert.ok(images[0]!.image_url.startsWith("data:image/png;base64,"));
	assert.equal((edit.body as { watermark: boolean }).watermark, true);
});
