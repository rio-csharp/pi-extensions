import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { marqueeWindow, renderDedicatedRow } from "./index.ts";

test("keeps a line that fits untouched", () => {
	assert.equal(marqueeWindow("1: short title", 40, 0), "1: short title");
	assert.equal(marqueeWindow("1: short title", 40, 250), "1: short title");
});

test("slides an overlong line through the window without exceeding the width", () => {
	const line = "1: 完善守恒经济与竞争策略 · amr-link/deepseek-v4.1-flash:medium · 15:46:41";
	const width = 24;
	const frames: string[] = [];
	for (let offset = 0; offset < 40; offset += 3) {
		const frame = marqueeWindow(line, width, offset);
		assert(visibleWidth(frame) <= width, `frame over width: ${JSON.stringify(frame)}`);
		assert(visibleWidth(frame) > 0);
		frames.push(frame);
	}
	assert(new Set(frames).size > 1, "the window never advanced");
	assert.notEqual(frames[0], frames[frames.length - 1]);
});

test("wraps around instead of stalling at the end", () => {
	const line = "abcdefghijklmnopqrstuvwxyz";
	const period = line.length + 3;
	const start = marqueeWindow(line, 5, 0);
	const sameAfterPeriod = marqueeWindow(line, 5, period);
	const sameAfterManyPeriods = marqueeWindow(line, 5, period * 7 + 0);
	assert.equal(sameAfterPeriod, start);
	assert.equal(sameAfterManyPeriods, start);
	assert.equal(marqueeWindow(line, 5, -3), marqueeWindow(line, 5, period - 3));
});

test("preserves ANSI styling while slicing", () => {
	const line = `\x1b[36m${"a".repeat(20)}\x1b[0m \x1b[2mplaceholder text that is long\x1b[0m`;
	const frame = marqueeWindow(line, 12, 5);
	assert.equal(visibleWidth(frame), 12);
	assert(frame.includes("\x1b["), "styling was dropped");
});

const MARKER = "\u200B";

/** From the producer: fixed row number, scrolling title, fixed tail. */
function row(number: string, title: string, tail: string): string {
	return `${number}${MARKER}${title}${MARKER}${tail}`;
}

const TAIL = " · amr-link/deepseek-flash · 15:46:41 · 12m03s · ↑1.2k ↓340 R0 · $0.0412";

test("scrolls only the title and pins the row number and tail", () => {
	const title = "cross-check every subagent extension module against pi 1.5.2 and report drift";
	const width = 120;
	const number = "1: ";
	const titleWindow = width - visibleWidth(number) - visibleWidth(TAIL);
	assert(titleWindow > 5);

	const frames = [0, 3, 9, 24].map((offset) => renderDedicatedRow(row(number, title, TAIL), width, offset));
	assert(frames.every((frame) => frame.scrolling));
	for (const frame of frames) {
		assert.equal(visibleWidth(frame.text), width);
		assert(frame.text.startsWith(number), `row number moved: ${JSON.stringify(frame.text)}`);
		assert(frame.text.endsWith(TAIL), `tail moved or was cut: ${JSON.stringify(frame.text)}`);
		const middle = frame.text.slice(number.length, frame.text.length - TAIL.length);
		assert.equal(visibleWidth(middle), titleWindow);
	}
	assert(new Set(frames.map((frame) => frame.text)).size > 1, "the title never advanced");
});

test("still supports a single marker for a scrolling head with a fixed tail", () => {
	const line = `1: a very long title that will not fit${MARKER}${TAIL}`;
	const rendered = renderDedicatedRow(line, 80, 0);
	assert.equal(rendered.scrolling, true);
	assert.equal(visibleWidth(rendered.text), 80);
	assert(rendered.text.endsWith(TAIL));
});

test("leaves a fitting title alone and never starts scrolling", () => {
	const rendered = renderDedicatedRow(row("1: ", "short task", TAIL), 120, 42);
	assert.equal(rendered.scrolling, false);
	assert.equal(rendered.text, `1: short task${TAIL}`);
	assert(!rendered.text.includes(MARKER));
});

test("falls back to a hard cut when the fixed parts alone do not fit", () => {
	const rendered = renderDedicatedRow(row("1: ", "title", TAIL), 20, 0);
	assert.equal(rendered.scrolling, false);
	assert(!rendered.text.includes(MARKER));
	assert(visibleWidth(rendered.text) <= 20);
});

test("pads a window that ends inside a wide grapheme so the pinned tail never shifts", () => {
	const title = "审查每一个子代理扩展模块并核对公开 API 表面与漂移风险";
	const width = 120;
	for (const offset of [0, 3, 7, 11, 23]) {
		const rendered = renderDedicatedRow(row("1: ", title, TAIL), width, offset);
		assert(rendered.scrolling, `offset ${offset} should scroll`);
		assert.equal(visibleWidth(rendered.text), width, `offset ${offset} lost a column`);
		assert(rendered.text.endsWith(TAIL), `offset ${offset} shifted the tail`);
		assert(rendered.text.startsWith("1: "), `offset ${offset} shifted the row number`);
	}
});

test("keeps scrolling whole lines that carry no marker", () => {
	const line = "a line from another extension that is far too long for the row";
	const rendered = renderDedicatedRow(line, 20, 6);
	assert.equal(rendered.scrolling, true);
	assert(visibleWidth(rendered.text) <= 20);
});
