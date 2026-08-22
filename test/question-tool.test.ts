import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import planMode, { normalizePlanModeQuestionParams } from "../src/plan-mode.js";
import {
	askPlanModeQuestions,
	MAX_PLAN_MODE_RESPONSE_LENGTH,
	type PlanModeQuestion,
	planModeQuestionAnswered,
	sanitizeTerminalText,
} from "../src/question-tool.js";

const questions: PlanModeQuestion[] = [
	{
		id: "scope",
		header: "Scope",
		question: "How broad?",
		options: [
			{ label: "Small", description: "Only the bug." },
			{ label: "Broad", description: "Include cleanup." },
		],
	},
	{
		id: "tests",
		header: "Tests",
		question: "Which checks?",
		options: [
			{ label: "Focused", description: "Run focused checks." },
			{ label: "Full", description: "Run all checks." },
		],
	},
];

function tuiRun(customQuestions = questions, width = 60) {
	const tui = createTuiHarness({ width, rows: 30 });
	const context = createMockContext({ mode: "tui", hasUI: true, custom: tui.custom });
	const running = askPlanModeQuestions(customQuestions, context.ctx);
	return { tui, running };
}

function paste(tui: ReturnType<typeof createTuiHarness>, text: string) {
	tui.send(`\u001b[200~${text}\u001b[201~`);
}

test("plan_mode_question reports non-interactive cancellation", async () => {
	const mock = createMockPi();
	planMode(mock.pi);
	const execute = mock.tools[0]?.execute as
		| ((...args: unknown[]) => Promise<{ details?: { reason?: string } }>)
		| undefined;
	assert.ok(execute);
	const context = createMockContext({ hasUI: false });
	await mock.commands.get("plan")?.handler("start", context.ctx);
	const result = await execute(
		"call-1",
		{ questions: [questions[0]] },
		undefined,
		undefined,
		context.ctx,
	);
	assert.equal(result.details?.reason, "ui_unavailable");
});

test("normalizePlanModeQuestionParams validates question shape without changing schema", () => {
	const result = normalizePlanModeQuestionParams({ questions: [questions[0]] });
	assert.equal(result.ok, true);
	if (result.ok) assert.equal(result.questions[0]?.options[1]?.label, "Broad");
	assert.deepEqual(normalizePlanModeQuestionParams({ questions: [] }), {
		ok: false,
		error: "questions must contain 1-3 items",
	});
});

test("TUI previews future questions and navigates back before answering", async () => {
	const { tui, running } = tuiRun();
	await tui.waitForOpen();
	tui.setFocused(true);
	assert.match(tui.render().join("\n"), /\[Scope\].*Tests.*Review/u);
	tui.send("\t");
	assert.match(tui.render().join("\n"), /Scope.*\[Tests\].*Review[\s\S]*Which checks\?/u);
	tui.send("\u001b[Z");
	assert.match(tui.render().join("\n"), /\[Scope\][\s\S]*How broad\?/u);
	tui.press("tui.select.cancel");
	assert.equal(await running, undefined);
});

test("TUI replaces answers, manages notes, accepts Other, and submits ordered raw payload", async () => {
	const { tui, running } = tuiRun();
	await tui.waitForOpen();
	tui.setFocused(true);

	// Note shortcut selects the highlighted answer before opening the editor.
	tui.type("n");
	paste(tui, "initial note");
	tui.press("tui.input.submit");
	assert.match(tui.render().join("\n"), /initial note/u);

	// Replacing the selected option clears its old note.
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	tui.send("\u001b[D");
	assert.doesNotMatch(tui.render().join("\n"), /initial note/u);
	tui.send("\u001b[C");

	// Other keeps exact user text in the answer payload.
	tui.press("tui.select.down");
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	paste(tui, "  custom answer  ");
	tui.press("tui.input.submit");
	assert.match(tui.render().join("\n"), /Review answers[\s\S]*Broad[\s\S]*custom answer/u);

	// Review selects answers for note add/edit/clear.
	tui.type("n");
	paste(tui, "draft note");
	tui.press("tui.input.submit");
	tui.type("n");
	tui.send("\u0015");
	tui.press("tui.input.submit");
	assert.match(tui.render().join("\n"), /Note cleared/u);
	tui.type("n");
	paste(tui, "final note");
	tui.press("tui.input.submit");
	tui.press("tui.select.confirm");

	assert.deepEqual(await running, [
		{
			id: "scope",
			header: "Scope",
			question: "How broad?",
			answer: "Broad",
			wasCustom: false,
			optionIndex: 2,
			note: "final note",
		},
		{
			id: "tests",
			header: "Tests",
			question: "Which checks?",
			answer: "  custom answer  ",
			wasCustom: true,
		},
	]);
});

test("Review blocks incomplete submission and lets selected answer receive a note", async () => {
	const { tui, running } = tuiRun();
	await tui.waitForOpen();
	tui.setFocused(true);
	tui.send("\u001b[C");
	tui.send("\u001b[C");
	tui.press("tui.select.confirm");
	assert.match(tui.render().join("\n"), /Answer every question before submitting/u);
	tui.press("tui.select.down");
	tui.type("n");
	assert.match(tui.render().join("\n"), /Select an answer before adding a note/u);
	tui.press("tui.select.cancel");
	assert.equal(await running, undefined);
});

test("TUI preserves raw custom answers and notes while sanitizing editor rendering", async () => {
	const unsafeAnswer = "raw\u001b]8;;https://evil.example\u0007text\u202ereversed";
	const unsafeNote = "note\u009bcontrol\u202aspoofed";
	const { tui, running } = tuiRun([questions[0]]);
	await tui.waitForOpen();
	tui.setFocused(true);
	tui.press("tui.select.down");
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	paste(tui, unsafeAnswer);
	const answerDraft = tui.render().join("\n");
	assert.equal(answerDraft.includes("\u202e"), false);
	assert.equal(answerDraft.includes("\u001b]8;;https://evil.example"), false);
	tui.press("tui.input.submit");
	tui.type("n");
	paste(tui, unsafeNote);
	const noteDraft = tui.render().join("\n");
	assert.equal(noteDraft.includes("\u009b"), false);
	assert.equal(noteDraft.includes("\u202a"), false);
	tui.press("tui.input.submit");
	const review = tui.render().join("\n");
	assert.equal(review.includes("\u202e") || review.includes("\u202a"), false);
	tui.press("tui.select.confirm");

	assert.deepEqual(await running, [
		{
			id: "scope",
			header: "Scope",
			question: "How broad?",
			answer: unsafeAnswer,
			wasCustom: true,
			note: unsafeNote,
		},
	]);
});

test("editing an existing Other answer preserves its note", async () => {
	const { tui, running } = tuiRun([questions[0]]);
	await tui.waitForOpen();
	tui.setFocused(true);
	tui.press("tui.select.down");
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	paste(tui, "first answer");
	tui.press("tui.input.submit");
	tui.type("n");
	paste(tui, "keep this note");
	tui.press("tui.input.submit");
	tui.send("\u001b[D");
	tui.press("tui.select.confirm");
	tui.send("\u0015");
	paste(tui, "edited answer");
	tui.press("tui.input.submit");
	tui.press("tui.select.confirm");

	assert.equal((await running)?.[0]?.note, "keep this note");
});

test("narrow TUI rendering keeps every question and Review tab visible", async () => {
	const longQuestions = [
		{ ...questions[0], header: "LongHeader12" },
		{ ...questions[1], header: "SecondHeader" },
		{ ...questions[0], id: "risk", header: "ThirdHeader3" },
	];
	const { tui, running } = tuiRun(longQuestions, 24);
	await tui.waitForOpen();
	tui.setFocused(true);
	for (let index = 0; index < longQuestions.length; index += 1) tui.send("\u001b[C");
	const frame = stripVTControlCharacters(tui.render().join("\n"));
	assert.match(frame, /LongHeader12/u);
	assert.match(frame, /SecondHeader/u);
	assert.match(frame, /ThirdHeader3/u);
	assert.match(frame, /\[Review\]/u);
	tui.dispose();
	assert.equal(await running, undefined);
});

test("TUI abort signal closes the questionnaire without answers", async () => {
	const controller = new AbortController();
	const tui = createTuiHarness({ width: 60, rows: 30 });
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		custom: tui.custom,
		signal: controller.signal,
	});
	const running = askPlanModeQuestions(questions, context.ctx);
	await tui.waitForOpen();
	controller.abort();
	assert.equal(await running, undefined);
	assert.equal(tui.isOpen, false);
});

test("Other editor rejects oversized input and forwards focus", async () => {
	const { tui, running } = tuiRun([questions[0]]);
	await tui.waitForOpen();
	tui.setFocused(true);
	tui.press("tui.select.down");
	tui.press("tui.select.down");
	tui.press("tui.select.confirm");
	tui.setFocused(true);
	assert.equal(tui.render().join("\n").includes(CURSOR_MARKER), true);
	paste(tui, "x".repeat(MAX_PLAN_MODE_RESPONSE_LENGTH + 1));
	tui.press("tui.input.submit");
	assert.match(tui.render().join("\n"), /4,000 characters or fewer/u);
	assert.equal(tui.isOpen, true);
	tui.press("ctrl+c");
	assert.equal(await running, undefined);
});

test("Note editor rejects oversized input and stays open", async () => {
	const { tui, running } = tuiRun([questions[0]]);
	await tui.waitForOpen();
	tui.setFocused(true);
	tui.type("n");
	const oversized = "z".repeat(MAX_PLAN_MODE_RESPONSE_LENGTH + 1);
	paste(tui, oversized);
	tui.press("tui.input.submit");
	const frame = tui.render().join("\n");
	assert.match(frame, /Note must be 4,000 characters or fewer/u);
	assert.equal(tui.isOpen, true);
	tui.press("ctrl+c");
	assert.equal(await running, undefined);
});

test("TUI sanitizes rendering, preserves raw result text, and respects narrow widths", async () => {
	const unsafe = "raw\u001b]8;;https://evil.example\u0007text\u001b]8;;\u0007";
	const malicious: PlanModeQuestion[] = [
		{
			id: "unsafe",
			header: `Head\u001b[31m`,
			question: unsafe,
			options: [
				{ label: unsafe, description: "first" },
				{ label: "safe", description: "second" },
			],
		},
	];
	const { tui, running } = tuiRun(malicious, 16);
	await tui.waitForOpen();
	tui.setFocused(true);
	const frame = tui.render();
	const plain = stripVTControlCharacters(frame.join("\n"));
	assert.doesNotMatch(plain, /evil\.example/u);
	assert.equal(plain.includes("\u0007") || plain.includes("\u001b"), false);
	for (const line of frame) assert.ok(visibleWidth(line) <= 16);
	assert.equal(sanitizeTerminalText(unsafe), "rawtext");
	const answered = planModeQuestionAnswered(malicious, [
		{
			id: "unsafe",
			header: malicious[0]?.header ?? "",
			question: unsafe,
			answer: unsafe,
			wasCustom: true,
		},
	]);
	assert.match(answered.content[0]?.text ?? "", /evil\.example/u);
	tui.dispose();
	assert.equal(await running, undefined);
});

test("RPC retains sequential select/editor fallback and retries oversized answers", async () => {
	const selections = ["1. Small — Only the bug.", "3. Other (free-form)"];
	const editorAnswers = ["x".repeat(MAX_PLAN_MODE_RESPONSE_LENGTH + 1), "rpc custom"];
	const context = createMockContext({
		mode: "rpc",
		hasUI: true,
		select: async () => selections.shift(),
		editor: async () => editorAnswers.shift(),
		custom: async () => assert.fail("RPC must not open custom TUI"),
	});
	const answers = await askPlanModeQuestions(questions, context.ctx);
	assert.deepEqual(
		answers?.map(({ answer, wasCustom }) => ({ answer, wasCustom })),
		[
			{ answer: "Small", wasCustom: false },
			{ answer: "rpc custom", wasCustom: true },
		],
	);
	assert.ok(context.notifications.some(({ message }) => message.includes("4,000")));
});
