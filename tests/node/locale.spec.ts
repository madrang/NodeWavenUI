import { expect } from 'chai';
import {
  configureLocaleDiagnostics,
  getLocalizedMessage,
  LOCALE_TOKEN_EXPRESSION,
  translate,
} from '../../dist/shared/locale.js';

describe('locale core', () => {
  describe('LOCALE_TOKEN_EXPRESSION', () => {
    it('matches every ${token} placeholder of one message', () => {
      expect('a ${x} b ${y.z} c'.match(LOCALE_TOKEN_EXPRESSION)).to.deep.equal(['${x}', '${y.z}']);
    });
  });

  describe('getLocalizedMessage', () => {
    describe('argument handling', () => {
      it('throws when no dictionary is given', () => {
        expect(() => getLocalizedMessage(null as unknown as Record<string, unknown>, 'x')).to.throw('Missing dictionary!');
      });

      it('returns non-string messages unchanged', () => {
        const dict: Record<string, unknown> = {};
        expect(getLocalizedMessage(dict, 42)).to.equal(42);
        expect(getLocalizedMessage(dict, undefined)).to.equal(undefined);
        expect(getLocalizedMessage(dict, null)).to.equal(null);
      });

      it('returns a message with no tokens unchanged', () => {
        const dict: Record<string, unknown> = {};
        expect(getLocalizedMessage(dict, 'plain text')).to.equal('plain text');
      });
    });

    describe('object dictionary', () => {
      it('resolves a single-segment token', () => {
        const dict: Record<string, unknown> = { name: 'Hero' };
        expect(getLocalizedMessage(dict, '${name}')).to.equal('Hero');
      });

      it('resolves a dotted token through nested objects', () => {
        const dict: Record<string, unknown> = { a: { b: { c: 'deep' } } };
        expect(getLocalizedMessage(dict, '${a.b.c}')).to.equal('deep');
      });

      it('leaves an unknown dotted token intact (full ${token})', () => {
        const dict: Record<string, unknown> = {};
        expect(getLocalizedMessage(dict, '${a.b.c}')).to.equal('${a.b.c}');
      });

      it('leaves an unknown single-segment token intact (full ${token})', () => {
        const dict: Record<string, unknown> = {};
        expect(getLocalizedMessage(dict, '${missing}')).to.equal('${missing}');
      });

      it('resolves multiple tokens in one message', () => {
        const dict: Record<string, unknown> = { who: 'world', what: 'hello' };
        expect(getLocalizedMessage(dict, '${what}, ${who}!')).to.equal('hello, world!');
      });

      it('ignores surrounding text outside the tokens', () => {
        const dict: Record<string, unknown> = { k: 'V' };
        expect(getLocalizedMessage(dict, 'before ${k} after')).to.equal('before V after');
      });
    });

    describe('function dictionary', () => {
      // This is the contract dynamic token sources rely on: a function dictionary gets
      // the token's name parts as separate arguments.
      it('calls the function with the token’s segments for a dotted name', () => {
        const dict = (...parts: string[]) => parts.join('|');
        expect(getLocalizedMessage(dict, '${a.b.c}')).to.equal('a|b|c');
      });

      it('calls the function with the single segment for a plain name', () => {
        const dict = (name: string) => `<${name}>`;
        expect(getLocalizedMessage(dict, '${name}')).to.equal('<name>');
      });

      it('leaves the token intact (full ${token}) when the function returns null/undefined', () => {
        const dict = () => null;
        expect(getLocalizedMessage(dict, '${a.b}')).to.equal('${a.b}');
      });
    });

    describe('recursive resolution', () => {
      // getLocalizedMessage re-scans its output until it stops changing, so a
      // value that itself contains a token resolves fully. A pass cap breaks
      // self-referential cycles.
      it('resolves a token embedded in a resolved value (object dict)', () => {
        const dict: Record<string, unknown> = { outer: 'x ${inner}', inner: 'Y' };
        expect(getLocalizedMessage(dict, '${outer}')).to.equal('x Y');
      });

      it('resolves a token embedded in a resolved value (function dict)', () => {
        const dict = (name: string) => (name === 'outer' ? 'x ${inner}' : 'Y');
        expect(getLocalizedMessage(dict, '${outer}')).to.equal('x Y');
      });

      it('leaves a resolved value intact when it has no tokens', () => {
        const dict: Record<string, unknown> = { outer: 'plain' };
        expect(getLocalizedMessage(dict, '${outer}')).to.equal('plain');
      });

      it('stops after ten passes on a self-referential token and reports it', () => {
        const warnings: string[] = [];
        configureLocaleDiagnostics((message) => warnings.push(message));
        try {
          const dict: Record<string, unknown> = { loop: 'a ${loop}' };
          const resolved = getLocalizedMessage(dict, '${loop}') as string;
          expect(resolved).to.contain('${loop}');
          expect(warnings.some((message) => message.includes('Stopped resolving after 10 passes'))).to.equal(true);
        } finally {
          configureLocaleDiagnostics((message) => console.warn(message));
        }
      });
    });
  });

  describe('translate', () => {
    const dict: Record<string, unknown> = {
      characters: {
        deleteCountdown: 'click delete ${countdown} more time${s} to confirm',
      },
    };

    it('resolves a dotted message path against the dictionary', () => {
      // countdown=3, s="s" → "...3 more times to confirm"
      expect(translate(dict, 'characters', 'deleteCountdown', { countdown: 3, s: 's' }))
        .to.equal('click delete 3 more times to confirm');
    });

    it('substitutes runtime tokens passed via the trailing object', () => {
      expect(translate(dict, 'characters', 'deleteCountdown', { countdown: 1, s: '' }))
        .to.equal('click delete 1 more time to confirm');
      expect(translate(dict, 'characters', 'deleteCountdown', { countdown: 2, s: 's' }))
        .to.equal('click delete 2 more times to confirm');
    });

    it('supports the singular/plural toggle the UI uses (s: \'\' vs \'s\')', () => {
      const render = (deleteCount: number): string => translate(
        dict,
        'characters',
        'deleteCountdown',
        { countdown: 4 - deleteCount, s: deleteCount === 3 ? '' : 's' },
      );
      expect(render(1)).to.equal('click delete 3 more times to confirm');
      expect(render(2)).to.equal('click delete 2 more times to confirm');
      expect(render(3)).to.equal('click delete 1 more time to confirm');
    });

    it('leaves an omitted runtime token intact (full ${token})', () => {
      // ${s} is unknown to the dictionary and not in the object → survives as ${s}.
      expect(translate(dict, 'characters', 'deleteCountdown', { countdown: 2 }))
        .to.equal('click delete 2 more time${s} to confirm');
    });

    it('merges the object over the dictionary (object tokens override)', () => {
      const withDictDefault: Record<string, unknown> = {
        characters: { deleteCountdown: '[${countdown}]' },
        countdown: 99,
      };
      // Object value wins over the dictionary’s own countdown.
      expect(translate(withDictDefault, 'characters', 'deleteCountdown', { countdown: 5 }))
        .to.equal('[5]');
    });

    it('uses a trailing function as the replacement dictionary', () => {
      expect(translate({ msg: '${k}' }, 'msg', (...parts: string[]) => `<${parts.join('.')}>`)).to.equal('<k>');
    });

    it('throws when the message path can’t be resolved', () => {
      expect(() => translate(dict, 'characters', 'missing')).to.throw('couldn\'t be translated!');
    });
  });
});
