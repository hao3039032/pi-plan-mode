import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type EditorTheme,
	type Focusable,
	Key,
	matchesKey,
	sliceByColumn,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export const PLAN_MODE_QUESTION_TOOL_NAME = "plan_mode_question";
export const MAX_PLAN_MODE_RESPONSE_LENGTH = 4_000;

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";

export type PlanModeQuestionOption = {
	label: string;
	description?: string;
};

export type PlanModeQuestion = {
	id: string;
	header: string;
	question: string;
	options: PlanModeQuestionOption[];
};

export type PlanModeQuestionAnswer = {
	id: string;
	header: string;
	question: string;
	answer: string;
	wasCustom: boolean;
	optionIndex?: number;
	note?: string;
};

type PlanModeQuestionReason =
	| "cancelled"
	| "ui_unavailable"
	| "plan_mode_inactive"
	| "invalid_input";

type PlanModeQuestionDetails = {
	cancelled: boolean;
	reason?: PlanModeQuestionReason;
	questions: PlanModeQuestion[];
	answers?: PlanModeQuestionAnswer[];
};

export const PLAN_MODE_QUESTION_PARAMS = {
	type: "object",
	additionalProperties: false,
	required: ["questions"],
	properties: {
		questions: {
			type: "array",
			minItems: 1,
			maxItems: 3,
			description: "Questions to show the user. Prefer 1 and do not exceed 3.",
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "header", "question", "options"],
				properties: {
					id: {
						type: "string",
						description: "Stable identifier for mapping answers (snake_case).",
					},
					header: {
						type: "string",
						description: "Short header label shown in the UI (12 or fewer chars).",
					},
					question: { type: "string", description: "Single-sentence prompt shown to the user." },
					options: {
						type: "array",
						minItems: 2,
						maxItems: 4,
						description:
							"Provide 2-4 mutually exclusive choices. Put the recommended option first when there is a clear default.",
						items: {
							type: "object",
							additionalProperties: false,
							required: ["label", "description"],
							properties: {
								label: { type: "string", description: "User-facing label (1-5 words)." },
								description: {
									type: "string",
									description: "One short sentence explaining impact/tradeoff if selected.",
								},
							},
						},
					},
				},
			},
		},
	},
} as const;

type NormalizePlanModeQuestionParamsResult =
	| { ok: true; questions: PlanModeQuestion[] }
	| { ok: false; error: string };

export function normalizePlanModeQuestionParams(
	input: unknown,
): NormalizePlanModeQuestionParamsResult {
	if (!isRecord(input) || !Array.isArray(input.questions)) {
		return { ok: false, error: "questions must be an array" };
	}
	if (input.questions.length < 1 || input.questions.length > 3) {
		return { ok: false, error: "questions must contain 1-3 items" };
	}

	const questions: PlanModeQuestion[] = [];
	for (const [questionIndex, rawQuestion] of input.questions.entries()) {
		if (!isRecord(rawQuestion)) {
			return { ok: false, error: `question ${questionIndex + 1} must be an object` };
		}
		const id = stringField(rawQuestion.id);
		const header = stringField(rawQuestion.header);
		const question = stringField(rawQuestion.question);
		if (!id || !header || !question) {
			return {
				ok: false,
				error: `question ${questionIndex + 1} requires non-empty id, header, and question`,
			};
		}
		if (!Array.isArray(rawQuestion.options)) {
			return { ok: false, error: `question ${questionIndex + 1} options must be an array` };
		}
		if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
			return { ok: false, error: `question ${questionIndex + 1} options must contain 2-4 items` };
		}
		const options: PlanModeQuestionOption[] = [];
		for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
			if (!isRecord(rawOption)) {
				return {
					ok: false,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} must be an object`,
				};
			}
			const label = stringField(rawOption.label);
			if (!label) {
				return {
					ok: false,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a label`,
				};
			}
			const description = stringField(rawOption.description);
			if (!description) {
				return {
					ok: false,
					error: `question ${questionIndex + 1} option ${optionIndex + 1} requires a description`,
				};
			}
			options.push({ label, description });
		}
		questions.push({ id, header, question, options });
	}
	return { ok: true, questions };
}

export async function answerPlanModeQuestions(
	questions: PlanModeQuestion[],
	ctx: ExtensionContext,
	lifecycle: { isCurrent(): boolean; isEnabled(): boolean },
) {
	const answers = await askPlanModeQuestions(
		questions,
		ctx,
		() => lifecycle.isCurrent() && lifecycle.isEnabled(),
	);
	if (!lifecycle.isCurrent()) {
		return planModeQuestionCancelled(
			questions,
			"cancelled",
			"Plan-mode question cancelled because the session changed.",
		);
	}
	if (!lifecycle.isEnabled()) {
		return planModeQuestionCancelled(
			questions,
			"plan_mode_inactive",
			"Plan-mode question cancelled because Plan mode is no longer active.",
		);
	}
	if (!answers) {
		return planModeQuestionCancelled(
			questions,
			"cancelled",
			"User cancelled the Plan-mode question prompt.",
		);
	}
	return planModeQuestionAnswered(questions, answers);
}

export async function askPlanModeQuestions(
	questions: PlanModeQuestion[],
	ctx: ExtensionContext,
	shouldContinue: () => boolean = () => true,
): Promise<PlanModeQuestionAnswer[] | undefined> {
	if (ctx.mode === "tui") {
		const answers = await ctx.ui.custom<PlanModeQuestionAnswer[] | undefined>(
			(tui, theme, keybindings, done) =>
				new PlanModeQuestionnaire({
					questions,
					tui,
					theme,
					keybindings,
					shouldContinue,
					signal: ctx.signal,
					onDone: done,
				}),
		);
		return shouldContinue() ? answers : undefined;
	}
	return askPlanModeQuestionsSequentially(questions, ctx, shouldContinue);
}

async function askPlanModeQuestionsSequentially(
	questions: PlanModeQuestion[],
	ctx: ExtensionContext,
	shouldContinue: () => boolean,
): Promise<PlanModeQuestionAnswer[] | undefined> {
	const answers: PlanModeQuestionAnswer[] = [];
	for (const question of questions) {
		const choices = question.options.map(formatPlanModeQuestionChoice);
		const otherChoice = `${question.options.length + 1}. Other (free-form)`;
		const choice = await ctx.ui.select(`${question.header}: ${question.question}`, [
			...choices,
			otherChoice,
		]);
		if (!shouldContinue() || !choice) return undefined;
		if (choice === otherChoice) {
			const customAnswer = await askCustomAnswer(question, ctx, shouldContinue);
			if (customAnswer === undefined) return undefined;
			answers.push(answerFor(question, customAnswer, { wasCustom: true }));
			continue;
		}
		const optionIndex = choices.indexOf(choice);
		const option = question.options[optionIndex];
		if (!option) return undefined;
		answers.push(
			answerFor(question, option.label, { wasCustom: false, optionIndex: optionIndex + 1 }),
		);
	}
	return answers;
}

async function askCustomAnswer(
	question: PlanModeQuestion,
	ctx: ExtensionContext,
	shouldContinue: () => boolean,
): Promise<string | undefined> {
	let draft = "";
	for (;;) {
		const customAnswer = await ctx.ui.editor(question.question, draft);
		if (!shouldContinue() || !customAnswer?.trim()) return undefined;
		if (customAnswer.length <= MAX_PLAN_MODE_RESPONSE_LENGTH) return customAnswer;
		draft = customAnswer;
		ctx.ui.notify("Custom answer must be 4,000 characters or fewer.", "warning");
	}
}

interface QuestionnaireOptions {
	questions: PlanModeQuestion[];
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
	shouldContinue(): boolean;
	signal?: AbortSignal;
	onDone(answers: PlanModeQuestionAnswer[] | undefined): void;
}

export class PlanModeQuestionnaire implements Component, Focusable {
	private readonly options: QuestionnaireOptions;
	private readonly editor: RawPreservingEditor;
	private readonly answers: Array<PlanModeQuestionAnswer | undefined>;
	private readonly selectedOptions: number[];
	private page = 0;
	private editorKind: "answer" | "note" | undefined;
	private message: string | undefined;
	private finished = false;
	private removeAbort = () => {};
	private _focused = false;

	constructor(options: QuestionnaireOptions) {
		this.options = options;
		this.answers = options.questions.map(() => undefined);
		this.selectedOptions = options.questions.map(() => 0);
		const editorTheme: EditorTheme = {
			borderColor: (text) => options.theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => options.theme.fg("accent", text),
				selectedText: (text) => options.theme.fg("accent", text),
				description: (text) => options.theme.fg("muted", text),
				scrollInfo: (text) => options.theme.fg("dim", text),
				noMatch: (text) => options.theme.fg("warning", text),
			},
		};
		this.editor = new RawPreservingEditor(options.tui, editorTheme);
		this.editor.onChange = () => {
			this.message = undefined;
		};
		this.editor.onSubmit = (text) => this.submitEditor(text);
		if (options.signal) {
			const abort = () => this.finish(undefined);
			options.signal.addEventListener("abort", abort, { once: true });
			this.removeAbort = () => options.signal?.removeEventListener("abort", abort);
			if (options.signal.aborted) abort();
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value && this.editorKind !== undefined;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const padding = safeWidth > 1 ? " " : "";
		const contentWidth = Math.max(1, safeWidth - visibleWidth(padding));
		const border = this.options.theme.fg("border", "─".repeat(safeWidth));
		const lines = [border, "", ...this.renderTabs(contentWidth), ""];
		if (this.page === this.options.questions.length) lines.push(...this.renderReview(contentWidth));
		else lines.push(...this.renderQuestion(contentWidth));
		if (this.message)
			lines.push(...hardWrap(this.options.theme.fg("warning", this.message), contentWidth));
		lines.push("");
		lines.push(truncateToWidth(this.renderHints(), contentWidth), "", border);
		return lines.map((line) => {
			if (!line || line === border) return line;
			return `${padding}${truncateToWidth(line, contentWidth)}`;
		});
	}

	handleInput(data: string): void {
		if (this.finished) return;
		if (!this.options.shouldContinue() || this.isCancel(data)) {
			this.finish(undefined);
			return;
		}
		if (this.editorKind) this.handleEditorInput(data);
		else this.handlePageInput(data);
		this.options.tui.requestRender();
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	dispose(): void {
		this.finish(undefined);
	}

	private isCancel(data: string): boolean {
		return this.options.keybindings.matches(data, "tui.select.cancel");
	}

	private handleEditorInput(data: string): void {
		const keybindings = this.options.keybindings;
		if (keybindings.matches(data, "tui.input.newLine")) {
			this.editor.handleInput(data);
		} else if (keybindings.matches(data, "tui.input.submit")) {
			this.submitEditor(this.editor.getExpandedText());
		} else {
			this.editor.handleInput(data);
		}
	}

	private handlePageInput(data: string): void {
		const keybindings = this.options.keybindings;
		const review = this.page === this.options.questions.length;
		if (keybindings.matches(data, "tui.select.up") || data === "k") {
			if (!review) this.moveSelection(-1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down") || data === "j") {
			if (!review) this.moveSelection(1);
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm") || data === "\n") {
			this.submitPage();
			return;
		}
		if (keybindings.matches(data, "tui.input.tab") || matchesKey(data, Key.right)) {
			this.movePage(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.movePage(-1);
			return;
		}
		if (data.toLowerCase() === "n") {
			if (review) this.message = "Return to a question to add or edit its note.";
			else this.editNote();
		}
	}

	private renderHints(): string {
		const { keybindings, theme } = this.options;
		const cancel = keybindingHint(theme, keybindings, "tui.select.cancel", "cancel");
		if (this.editorKind) {
			return [
				keybindingHint(theme, keybindings, "tui.input.submit", "save"),
				keybindingHint(theme, keybindings, "tui.input.newLine", "newline"),
				cancel,
			].join("  ");
		}
		const questions = rawKeyHint(theme, questionNavigationKeys(keybindings), "questions");
		if (this.page === this.options.questions.length) {
			return [
				keybindingHint(theme, keybindings, "tui.select.confirm", "submit"),
				cancel,
				questions,
			].join("  ");
		}
		return [
			rawKeyHint(theme, selectionNavigationKeys(keybindings), "navigate"),
			keybindingHint(theme, keybindings, "tui.select.confirm", "select"),
			cancel,
			questions,
			rawKeyHint(theme, "n", "note"),
		].join("  ");
	}

	private movePage(delta: number): void {
		const pageCount = this.options.questions.length + 1;
		this.page = (this.page + delta + pageCount) % pageCount;
		const answer = this.answers[this.page];
		const question = this.options.questions[this.page];
		if (answer?.wasCustom && question) {
			this.selectedOptions[this.page] = question.options.length;
		} else if (answer?.optionIndex !== undefined) {
			this.selectedOptions[this.page] = answer.optionIndex - 1;
		}
		this.message = undefined;
	}

	private renderTabs(width: number): string[] {
		const tabs = [
			...this.options.questions.map((question, index) => {
				const label = sanitizeTerminalText(question.header) || `Question ${index + 1}`;
				const answered = this.answers[index] ? "✓ " : "";
				return this.page === index ? `[${answered}${label}]` : `${answered}${label}`;
			}),
			this.page === this.options.questions.length ? "[Review]" : "Review",
		];
		const lines: string[] = [];
		let line = "";
		for (const tab of tabs) {
			const boundedTab = truncateToWidth(tab, width, "…");
			const candidate = line ? `${line}  ${boundedTab}` : boundedTab;
			if (line && visibleWidth(candidate) > width) {
				lines.push(this.options.theme.fg("accent", line));
				line = boundedTab;
			} else {
				line = candidate;
			}
		}
		if (line) lines.push(this.options.theme.fg("accent", line));
		return lines;
	}

	private renderQuestion(width: number): string[] {
		const question = this.options.questions[this.page];
		if (!question) return [];
		const lines = hardWrap(
			this.options.theme.fg(
				"accent",
				this.options.theme.bold(sanitizeTerminalText(question.question)),
			),
			width,
		);
		lines.push("");
		question.options.forEach((option, index) => {
			const selected = this.selectedOptions[this.page] === index;
			const cursor = selected ? "→" : " ";
			const label = `${cursor} ${index + 1}. ${sanitizeTerminalText(option.label)}`;
			const chosen = this.answers[this.page]?.optionIndex === index + 1;
			const description = option.description
				? ` — ${sanitizeTerminalText(option.description)}`
				: "";
			const line = selected
				? this.options.theme.fg("accent", `${label}${chosen ? " ✓" : ""}${description}`)
				: `${this.options.theme.fg("text", label)}${
						chosen ? this.options.theme.fg("success", " ✓") : ""
					}${description ? this.options.theme.fg("muted", description) : ""}`;
			lines.push(...hardWrapWithIndent(line, width, visibleWidth(`${cursor} ${index + 1}. `)));
		});
		const otherIndex = question.options.length;
		const otherSelected = this.selectedOptions[this.page] === otherIndex;
		const otherCursor = otherSelected ? "→" : " ";
		const otherLabel = `${otherCursor} ${otherIndex + 1}. Other (free-form)`;
		const otherChosen = this.answers[this.page]?.wasCustom === true;
		lines.push(
			otherSelected
				? this.options.theme.fg("accent", `${otherLabel}${otherChosen ? " ✓" : ""}`)
				: `${this.options.theme.fg("text", otherLabel)}${
						otherChosen ? this.options.theme.fg("success", " ✓") : ""
					}`,
		);
		const answer = this.answers[this.page];
		if (answer?.wasCustom)
			lines.push(...labeledRaw("Answer", answer.answer, width, this.options.theme));
		if (answer?.note) lines.push(...labeledRaw("Note", answer.note, width, this.options.theme));
		if (this.editorKind) {
			lines.push("");
			lines.push(
				this.options.theme.fg(
					"accent",
					this.editorKind === "answer" ? "Custom answer" : "Optional note",
				),
			);
			lines.push(...this.editor.render(width));
		}
		return lines;
	}

	private renderReview(width: number): string[] {
		const lines = [this.options.theme.fg("accent", this.options.theme.bold("Review answers")), ""];
		this.options.questions.forEach((question, index) => {
			const answer = this.answers[index];
			const header = sanitizeTerminalText(question.header) || `Question ${index + 1}`;
			const label = `${index + 1}. ${header}`;
			const summary = ` — ${inlineSummary(answer?.answer ?? "Unanswered")}${
				answer?.note ? ` · Note: ${inlineSummary(answer.note)}` : ""
			}`;
			const line = `${this.options.theme.fg("text", label)}${this.options.theme.fg("muted", summary)}`;
			lines.push(...hardWrapWithIndent(line, width, visibleWidth(`${index + 1}. `)));
		});
		return lines;
	}

	private moveSelection(delta: number): void {
		const optionCount = (this.options.questions[this.page]?.options.length ?? 0) + 1;
		this.selectedOptions[this.page] =
			((this.selectedOptions[this.page] ?? 0) + delta + optionCount) % optionCount;
	}

	private submitPage(): void {
		if (this.page === this.options.questions.length) {
			const firstMissing = this.answers.findIndex((answer) => !answer);
			if (firstMissing >= 0) {
				this.message = "Answer every question before submitting.";
				return;
			}
			this.finish(
				this.answers.filter((answer): answer is PlanModeQuestionAnswer => answer !== undefined),
			);
			return;
		}
		const question = this.options.questions[this.page];
		if (!question) return;
		const selected = this.selectedOptions[this.page] ?? 0;
		if (selected === question.options.length) {
			this.beginEditor(
				"answer",
				this.answers[this.page]?.wasCustom ? this.answers[this.page]?.answer : "",
			);
			return;
		}
		const option = question.options[selected];
		if (!option) return;
		const previous = this.answers[this.page];
		this.answers[this.page] = answerFor(question, option.label, {
			wasCustom: false,
			optionIndex: selected + 1,
			note: previous?.optionIndex === selected + 1 ? previous.note : undefined,
		});
		this.advance();
	}

	private editNote(): void {
		const index = this.page;
		let answer = this.answers[index];
		const question = this.options.questions[index];
		const selected = this.selectedOptions[index] ?? 0;
		if (question && selected === question.options.length && !answer?.wasCustom) {
			this.beginEditor("answer", "");
			return;
		}
		if (question && selected < question.options.length && answer?.optionIndex !== selected + 1) {
			const option = question.options[selected];
			if (option) {
				answer = answerFor(question, option.label, {
					wasCustom: false,
					optionIndex: selected + 1,
				});
				this.answers[index] = answer;
			}
		}
		if (!answer) {
			this.message = "Select an answer before adding a note.";
			return;
		}
		this.beginEditor("note", answer.note ?? "");
	}

	private beginEditor(kind: "answer" | "note", value: string | undefined): void {
		this.editorKind = kind;
		this.editor.setText(value ?? "");
		this.editor.focused = this._focused;
		this.message = undefined;
	}

	private submitEditor(value: string): void {
		if (value.length > MAX_PLAN_MODE_RESPONSE_LENGTH) {
			this.editor.setText(value);
			this.message = `${this.editorKind === "answer" ? "Answer" : "Note"} must be 4,000 characters or fewer.`;
			this.options.tui.requestRender();
			return;
		}
		const index = this.page;
		if (this.editorKind === "answer") {
			if (!value.trim()) {
				this.editor.setText(value);
				this.message = "Custom answer cannot be empty.";
				this.options.tui.requestRender();
				return;
			}
			const question = this.options.questions[index];
			if (!question) return;
			const previous = this.answers[index];
			this.answers[index] = answerFor(question, value, {
				wasCustom: true,
				note: previous?.wasCustom ? previous.note : undefined,
			});
			this.editor.setText("");
			this.editorKind = undefined;
			this.editor.focused = false;
			this.advance();
			return;
		}
		const answer = this.answers[index];
		if (answer) answer.note = value.trim() ? value : undefined;
		this.editor.setText("");
		this.editorKind = undefined;
		this.editor.focused = false;
		this.message = value.trim() ? "Note saved." : "Note cleared.";
		this.options.tui.requestRender();
	}

	private advance(): void {
		this.page = Math.min(this.page + 1, this.options.questions.length);
		this.message = undefined;
	}

	private finish(answers: PlanModeQuestionAnswer[] | undefined): void {
		if (this.finished) return;
		this.finished = true;
		this.removeAbort();
		this.removeAbort = () => {};
		this.editor.focused = false;
		this.options.onDone(answers);
	}
}

class RawPreservingEditor implements Focusable {
	private readonly editor: Editor;
	private readonly rawByMarker = new Map<string, string>();
	private markerCodePoint = 0xe000;
	private pasteBuffer: string | undefined;

	constructor(tui: TUI, theme: EditorTheme) {
		this.editor = new Editor(tui, theme, { paddingX: 0 });
	}

	get focused(): boolean {
		return this.editor.focused;
	}

	set focused(value: boolean) {
		this.editor.focused = value;
	}

	set onChange(handler: ((value: string) => void) | undefined) {
		this.editor.onChange = handler ? () => handler(this.getExpandedText()) : undefined;
	}

	set onSubmit(handler: ((value: string) => void) | undefined) {
		this.editor.onSubmit = handler ? (value) => handler(this.decode(value)) : undefined;
	}

	handleInput(data: string): void {
		if (this.pasteBuffer !== undefined) {
			this.pasteBuffer += data;
			this.flushPasteBuffer();
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.editor.handleInput(data);
			return;
		}
		const pasteStart = data.indexOf(BRACKETED_PASTE_START);
		if (pasteStart >= 0) {
			if (pasteStart > 0) this.editor.handleInput(data.slice(0, pasteStart));
			this.pasteBuffer = data.slice(pasteStart + BRACKETED_PASTE_START.length);
			this.flushPasteBuffer();
			return;
		}
		if (
			[...data].some(
				(character) => isUnsafeDirectEditorCharacter(character) || this.rawByMarker.has(character),
			)
		) {
			this.editor.handleInput(this.encode(data));
			return;
		}
		this.editor.handleInput(data);
	}

	render(width: number): string[] {
		return this.editor
			.render(width)
			.map((line) =>
				[...line].map((character) => (this.rawByMarker.has(character) ? " " : character)).join(""),
			);
	}

	invalidate(): void {
		this.editor.invalidate();
	}

	setText(value: string): void {
		this.rawByMarker.clear();
		this.markerCodePoint = 0xe000;
		this.pasteBuffer = undefined;
		this.editor.setText(this.encode(value));
	}

	getExpandedText(): string {
		return this.decode(this.editor.getExpandedText());
	}

	private flushPasteBuffer(): void {
		if (this.pasteBuffer === undefined) return;
		const pasteEnd = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
		if (pasteEnd < 0) return;
		const raw = this.pasteBuffer.slice(0, pasteEnd);
		const remaining = this.pasteBuffer.slice(pasteEnd + BRACKETED_PASTE_END.length);
		this.pasteBuffer = undefined;
		this.editor.handleInput(`${BRACKETED_PASTE_START}${this.encode(raw)}${BRACKETED_PASTE_END}`);
		if (remaining) this.handleInput(remaining);
	}

	private encode(value: string): string {
		const forbidden = new Set([
			...value,
			...this.editor.getExpandedText(),
			...this.rawByMarker.keys(),
		]);
		return [...value]
			.map((character) => {
				if (!isUnsafeEditorCharacter(character) && !this.rawByMarker.has(character)) {
					return character;
				}
				const marker = this.nextMarker(forbidden);
				this.rawByMarker.set(marker, character);
				forbidden.add(marker);
				return marker;
			})
			.join("");
	}

	private decode(value: string): string {
		return [...value].map((character) => this.rawByMarker.get(character) ?? character).join("");
	}

	private nextMarker(forbidden: ReadonlySet<string>): string {
		for (;;) {
			if (this.markerCodePoint === 0xf900) this.markerCodePoint = 0xf0000;
			if (this.markerCodePoint === 0xffffe) this.markerCodePoint = 0x100000;
			if (this.markerCodePoint > 0x10fffd) {
				throw new Error("Plan-mode editor exhausted its safe input markers.");
			}
			const marker = String.fromCodePoint(this.markerCodePoint++);
			if (!forbidden.has(marker)) return marker;
		}
	}
}

function isUnsafeDirectEditorCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0) ?? 0;
	return (
		(codePoint >= 0x7f && codePoint <= 0x9f) ||
		codePoint === 0x2028 ||
		codePoint === 0x2029 ||
		isBidiControl(codePoint)
	);
}

function isUnsafeEditorCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0) ?? 0;
	return (
		character !== "\n" &&
		(codePoint <= 0x1f ||
			(codePoint >= 0x7f && codePoint <= 0x9f) ||
			codePoint === 0x2028 ||
			codePoint === 0x2029 ||
			isBidiControl(codePoint))
	);
}

function answerFor(
	question: PlanModeQuestion,
	answer: string,
	options: { wasCustom: boolean; optionIndex?: number; note?: string },
): PlanModeQuestionAnswer {
	const result: PlanModeQuestionAnswer = {
		id: question.id,
		header: question.header,
		question: question.question,
		answer,
		wasCustom: options.wasCustom,
	};
	if (options.optionIndex !== undefined) result.optionIndex = options.optionIndex;
	if (options.note !== undefined) result.note = options.note;
	return result;
}

function formatPlanModeQuestionChoice(option: PlanModeQuestionOption, index: number) {
	return `${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`;
}

export function planModeQuestionAnswered(
	questions: PlanModeQuestion[],
	answers: PlanModeQuestionAnswer[],
) {
	return {
		content: [
			{ type: "text" as const, text: formatPlanModeQuestionPayload({ cancelled: false, answers }) },
		],
		details: { cancelled: false, questions, answers } satisfies PlanModeQuestionDetails,
	};
}

export function planModeQuestionCancelled(
	questions: PlanModeQuestion[],
	reason: PlanModeQuestionReason,
	message: string,
) {
	return {
		content: [
			{
				type: "text" as const,
				text: formatPlanModeQuestionPayload({ cancelled: true, reason, message }),
			},
		],
		details: { cancelled: true, reason, questions } satisfies PlanModeQuestionDetails,
	};
}

function formatPlanModeQuestionPayload(payload: {
	cancelled: boolean;
	reason?: PlanModeQuestionReason;
	message?: string;
	answers?: PlanModeQuestionAnswer[];
}) {
	return JSON.stringify(payload, null, 2);
}

export function sanitizeTerminalText(value: string): string {
	return [...stripVTControlCharacters(value)]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f ||
				(codePoint >= 0x7f && codePoint <= 0x9f) ||
				codePoint === 0x2028 ||
				codePoint === 0x2029 ||
				isBidiControl(codePoint)
				? " "
				: character;
		})
		.join("");
}

function isBidiControl(codePoint: number): boolean {
	return (
		codePoint === 0x061c ||
		codePoint === 0x200e ||
		codePoint === 0x200f ||
		(codePoint >= 0x202a && codePoint <= 0x202e) ||
		(codePoint >= 0x2066 && codePoint <= 0x2069)
	);
}

type QuestionnaireKeybinding = Parameters<KeybindingsManager["getKeys"]>[0];

function keybindingHint(
	theme: Theme,
	keybindings: KeybindingsManager,
	keybinding: QuestionnaireKeybinding,
	description: string,
): string {
	return rawKeyHint(theme, formatHintKeys(keybindings.getKeys(keybinding)), description);
}

function rawKeyHint(theme: Theme, keys: string, description: string): string {
	return `${theme.fg("dim", keys)}${theme.fg("muted", ` ${description}`)}`;
}

function selectionNavigationKeys(keybindings: KeybindingsManager): string {
	const up = keybindings.getKeys("tui.select.up");
	const down = keybindings.getKeys("tui.select.down");
	if (up.includes("up") && down.includes("down")) {
		return formatHintKeys([
			"↑↓",
			...up.filter((key) => key !== "up"),
			...down.filter((key) => key !== "down"),
		]);
	}
	return formatHintKeys([...up, ...down]);
}

function questionNavigationKeys(keybindings: KeybindingsManager): string {
	return formatHintKeys([...keybindings.getKeys("tui.input.tab"), "shift+tab", "←→"]);
}

function formatHintKeys(keys: readonly string[]): string {
	return [...new Set(keys)].map(formatHintKey).join("/");
}

function formatHintKey(key: string): string {
	return key
		.split("+")
		.map((part) =>
			process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part,
		)
		.join("+");
}

function inlineSummary(value: string): string {
	return value.split("\n").map(sanitizeTerminalText).join(" ↵ ");
}

function labeledRaw(label: string, value: string, width: number, theme: Theme): string[] {
	const prefix = `${label}: `;
	const safe = sanitizeTerminalText(value);
	const lines = hardWrap(safe, Math.max(1, width - visibleWidth(prefix)));
	return lines.map((line, index) =>
		index === 0 ? `${theme.fg("muted", prefix)}${line}` : `${" ".repeat(prefix.length)}${line}`,
	);
}

function hardWrapWithIndent(value: string, width: number, indent: number): string[] {
	const safeWidth = Math.max(1, width);
	const safeIndent = Math.min(Math.max(0, indent), Math.max(0, safeWidth - 1));
	const continuationWidth = Math.max(1, safeWidth - safeIndent);
	const columns = visibleWidth(value);
	if (columns <= safeWidth) return [value];
	const output = [sliceByColumn(value, 0, safeWidth)];
	for (let column = safeWidth; column < columns; column += continuationWidth) {
		output.push(`${" ".repeat(safeIndent)}${sliceByColumn(value, column, continuationWidth)}`);
	}
	return output;
}

function hardWrap(value: string, width: number): string[] {
	const safeWidth = Math.max(1, width);
	if (!value) return [""];
	const output: string[] = [];
	for (const sourceLine of value.split("\n")) {
		const columns = visibleWidth(sourceLine);
		if (columns === 0) output.push("");
		else {
			for (let column = 0; column < columns; column += safeWidth) {
				output.push(sliceByColumn(sourceLine, column, safeWidth));
			}
		}
	}
	return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringField(value: unknown) {
	return typeof value === "string" ? value.trim() : undefined;
}
