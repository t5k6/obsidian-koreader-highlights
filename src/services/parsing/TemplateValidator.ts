export interface ValidationResult {
	isValid: boolean;
	errors: string[];
	warnings: string[];
	suggestions: string[];
}

export class TemplateValidator {
	// Match simple variables like {{pageno}}, excluding control tags (#,/)
	private static readonly SIMPLE_VAR_REGEX = /\{\{((?!#|\/)[\w]+)\}\}/g;
	private static readonly CONDITIONAL_OPEN = /\{\{#([\w]+)\}\}/g;
	private static readonly CONDITIONAL_CLOSE = /\{\{\/([\w]+)\}\}/g;
	private static readonly ANY_TAG = /\{\{([^}]+)?\}\}/g;

	validate(template: string): ValidationResult {
		const errors: string[] = [];
		const warnings: string[] = [];
		const suggestions: string[] = [];

		this.checkRequiredVars(template, errors, suggestions);
		this.validateConditionals(template, errors);
		this.validateSyntax(template, errors);

		// Heuristic: flag unknown/malformed tags
		this.checkUnknownTags(template, errors, warnings);

		return { isValid: errors.length === 0, errors, warnings, suggestions };
	}

	private checkRequiredVars(
		template: string,
		errors: string[],
		suggestions: string[],
	): void {
		const required = ["highlight", "pageno"];
		const found = new Set(
			[...template.matchAll(TemplateValidator.SIMPLE_VAR_REGEX)].map(
				(m) => m[1],
			),
		);
		for (const v of required) {
			if (!found.has(v)) {
				errors.push(`Missing required variable: {{${v}}}`);
				suggestions.push(`Add {{${v}}} to the template`);
			}
		}
	}

	private validateConditionals(template: string, errors: string[]): void {
		const stack: string[] = [];
		// Scan left-to-right for opens and closes using a combined regex
		const tagRegex = /\{\{([#/])([\w]+)\}\}/g;
		let m: RegExpExecArray | null;
		for (;;) {
			m = tagRegex.exec(template);
			if (m === null) break;
			const type = m[1];
			const key = m[2];
			if (type === "#") {
				stack.push(key);
			} else {
				// type === '/'
				if (stack.length === 0) {
					errors.push(`Unmatched closing tag {{/${key}}}`);
				} else {
					const open = stack.pop()!;
					if (open !== key) {
						errors.push(
							`Mismatched conditional: opened {{#${open}}} but closed {{/${key}}}`,
						);
					}
				}
			}
		}
		if (stack.length > 0) {
			for (const k of stack.reverse()) {
				errors.push(`Unclosed conditional block {{#${k}}}`);
			}
		}
	}

	private validateSyntax(template: string, errors: string[]): void {
		// Detect lone '{{' or '}}'
		const opens = (template.match(/\{\{/g) || []).length;
		const closes = (template.match(/\}\}/g) || []).length;
		if (opens !== closes) {
			errors.push(
				`Unbalanced template braces: found ${opens} '{{' and ${closes} '}}'`,
			);
		}
	}

	private checkUnknownTags(
		template: string,
		errors: string[],
		warnings: string[],
	): void {
		const validControl = /^(#|\/)\w+$/; // control tags handled elsewhere
		const validVar = /^\w+$/; // simple variables like {{pageno}}

		let match: RegExpExecArray | null;
		TemplateValidator.ANY_TAG.lastIndex = 0;
		for (;;) {
			match = TemplateValidator.ANY_TAG.exec(template);
			if (match === null) break;
			const inner = match[1]?.trim() ?? "";
			if (!inner) {
				errors.push("Empty template tag {{}} detected");
				continue;
			}
			if (validControl.test(inner)) continue; // handled by conditional check
			if (validVar.test(inner)) continue; // simple var OK
			// Anything else looks malformed or unsupported
			warnings.push(`Unsupported or malformed tag '{{${inner}}}'`);
		}
	}
}
