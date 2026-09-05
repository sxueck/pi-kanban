export class TurnState {
	private nextPosition = 1;
	private activePosition: number | null = null;

	reset(): void {
		this.nextPosition = 1;
		this.activePosition = null;
	}

	start(): number {
		const position = this.nextPosition++;
		this.activePosition = position;
		return position;
	}

	finish(): number | undefined {
		const position = this.activePosition;
		this.activePosition = null;
		return position ?? undefined;
	}

	get current(): number | undefined {
		return this.activePosition ?? undefined;
	}
}
