/**
 * Type declarations for the EditContext API (https://w3c.github.io/edit-context/).
 * The API ships with Chromium 133 and later, and the app runs on NW.js with Chromium 134 or newer.
 * The DOM library of TypeScript 7.0.2 predates the API and ships no declarations for it,
 * so this file declares the surface the editor page uses. It adds nothing at runtime.
 */

/** The starting state of an EditContext: the text and the selection it opens with. */
declare global {
  interface EditContextInit {
    readonly text?: string;
    readonly selectionStart?: number;
    readonly selectionEnd?: number;
  }

  /** One IME text format: the styled range the input method asks the page to render. */
  interface TextFormat {
    readonly rangeStart: number;
    readonly rangeEnd: number;
    readonly underlineStyle: 'none' | 'solid' | 'double' | 'dotted' | 'dashed' | 'wavy';
    readonly underlineThickness: 'none' | 'thin' | 'thick';
  }

  /** The event the EditContext fires after it applied a text change. The text and selection properties of the context already hold the new state. */
  interface TextUpdateEvent extends Event {
    /** The text the user entered, which replaced the range below. */
    readonly text: string;
    readonly updateRangeStart: number;
    readonly updateRangeEnd: number;
    readonly selectionStart: number;
    readonly selectionEnd: number;
  }

  /** The event the EditContext fires when the input method asks for new text formats, during a composition. */
  interface TextFormatUpdateEvent extends Event {
    getTextFormats(): readonly TextFormat[];
  }

  /** The event the EditContext fires when the input method asks where the composed characters sit. */
  interface CharacterBoundsUpdateEvent extends Event {
    readonly rangeStart: number;
    readonly rangeEnd: number;
  }

  interface EditContextEventMap {
    textupdate: TextUpdateEvent;
    textformatupdate: TextFormatUpdateEvent;
    characterboundsupdate: CharacterBoundsUpdateEvent;
    compositionstart: CompositionEvent;
    compositionend: CompositionEvent;
  }

  /**
   * The text edit context of an element. The element the context attaches to receives text input
   * through the context instead of the default editing behavior, and the page renders the text itself.
   */
  interface EditContext extends EventTarget {
    readonly text: string;
    readonly selectionStart: number;
    readonly selectionEnd: number;
    /** The offset where the character bounds of the last composition start. */
    readonly characterBoundsRangeStart: number;

    /** Replaces a range of the text. The context does not fire an event for its own updates. */
    updateText(rangeStart: number, rangeEnd: number, text: string): void;
    /** Sets the selection. */
    updateSelection(start: number, end: number): void;
    /** Tells the input method where the editable area sits, in viewport coordinates. */
    updateControlBounds(controlBounds: DOMRect): void;
    /** Tells the input method where the selection sits, in viewport coordinates. */
    updateSelectionBounds(selectionBounds: DOMRect): void;
    /** Tells the input method where the characters of a composition sit, in viewport coordinates. */
    updateCharacterBounds(rangeStart: number, characterBounds: readonly DOMRect[]): void;
    /** The character bounds the page reported for the last composition. */
    characterBounds(): readonly DOMRect[];
    /** The elements this context attaches to. At most one element attaches. */
    attachedElements(): readonly HTMLElement[];

    addEventListener<K extends keyof EditContextEventMap>(
      type: K,
      listener: (this: EditContext, event: EditContextEventMap[K]) => void,
      options?: boolean | AddEventListenerOptions,
    ): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
    removeEventListener<K extends keyof EditContextEventMap>(
      type: K,
      listener: (this: EditContext, event: EditContextEventMap[K]) => void,
      options?: boolean | EventListenerOptions,
    ): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
  }

  interface HTMLElement {
    /** The edit context of the element. The element receives text input through the attached context. */
    editContext: EditContext | null;
  }

  var EditContext: {
    new (options?: EditContextInit): EditContext;
    readonly prototype: EditContext;
  };
}

export {};
