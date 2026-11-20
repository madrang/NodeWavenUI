import { expect } from 'chai';
import {
  countRe,
  createLogHandler,
  createLogger,
  EventLevels,
  mapArgsToString,
  valueToString,
  type LogConstructor,
  type PrintEvent,
  type PrintFilter,
} from '../../dist/shared/logging.js';

describe('logging', () => {
  /** Builds one handler that records every printed event. */
  function recordingHandler(events: unknown[][]): LogConstructor {
    const printEvent: PrintEvent = (_logger, logLevel, args) => {
      events.push([logLevel, ...args]);
    };
    const printFilter: PrintFilter = () => true;
    return createLogHandler(printEvent, printFilter);
  }

  describe('createLogHandler', () => {
    it('throws when a print callback is missing', () => {
      expect(() => createLogHandler(undefined as unknown as PrintEvent, () => true)).to.throw('printEvent is not a function.');
      expect(() => createLogHandler(() => {}, undefined as unknown as PrintFilter)).to.throw('printFilter is not a function.');
    });

    it('throws when the logger name is missing or not a string', () => {
      const Ctor = recordingHandler([]);
      expect(() => new Ctor(undefined as unknown as string)).to.throw('Name is undefined.');
      expect(() => new Ctor(42 as unknown as string)).to.throw('Name is not a string.');
    });

    it('prints one event per level method at that level bit', () => {
      const events: unknown[][] = [];
      const log = createLogger(null, 'System', recordingHandler(events));
      log.emergency('a');
      log.fatal('b');
      log.critical('c');
      log.error('d');
      log.warning('e');
      log.notice('f');
      log.informative('g');
      log.debug('h');
      log.trace('i');
      expect(events).to.deep.equal([
        [EventLevels.EMERGENCY, 'a'],
        [EventLevels.FATAL, 'b'],
        [EventLevels.CRITICAL, 'c'],
        [EventLevels.ERROR, 'd'],
        [EventLevels.WARNING, 'e'],
        [EventLevels.NOTICE, 'f'],
        [EventLevels.INFORMATIVE, 'g'],
        [EventLevels.DEBUG, 'h'],
        [EventLevels.TRACE, 'i'],
      ]);
    });

    it('aliases info and warn to informative and warning', () => {
      const events: unknown[][] = [];
      const log = createLogger(null, 'System', recordingHandler(events));
      log.info('x');
      log.warn('y');
      expect(events).to.deep.equal([
        [EventLevels.INFORMATIVE, 'x'],
        [EventLevels.WARNING, 'y'],
      ]);
    });

    it('suppresses one event the filter refuses', () => {
      const events: unknown[][] = [];
      const printEvent: PrintEvent = (_logger, logLevel, args) => {
        events.push([logLevel, ...args]);
      };
      const printFilter: PrintFilter = (_logger, logLevel) => logLevel !== EventLevels.DEBUG;
      const log = createLogger(null, 'System', createLogHandler(printEvent, printFilter));
      log.debug('hidden');
      log.informative('shown');
      expect(events).to.deep.equal([[EventLevels.INFORMATIVE, 'shown']]);
    });

    it('prints through print at an explicit level, bypassing the filter', () => {
      const events: unknown[][] = [];
      const printEvent: PrintEvent = (_logger, logLevel, args) => {
        events.push([logLevel, ...args]);
      };
      const printFilter: PrintFilter = () => false;
      const log = createLogger(null, 'System', createLogHandler(printEvent, printFilter));
      log.notice('hidden by the filter');
      log.print(EventLevels.NOTICE, ['direct']);
      expect(events).to.deep.equal([[EventLevels.NOTICE, 'direct']]);
    });
  });

  describe('createLogger', () => {
    it('requires a constructor without a parent', () => {
      expect(() => createLogger(null, 'System')).to.throw('loggerCtor is required to be a function.');
    });

    it('elides the System root from child names', () => {
      const events: unknown[][] = [];
      const log = createLogger(null, 'System', recordingHandler(events));
      log.mcp.host!.warning('down');
      expect(events).to.deep.equal([[EventLevels.WARNING, 'down']]);
      expect(log.mcp.host!.name).to.equal('mcp->host');
    });

    it('keeps the name of a non-System root on its children', () => {
      const Ctor = recordingHandler([]);
      const root = createLogger(null, 'Node', Ctor);
      expect(root.child!.name).to.equal('Node->child');
    });

    it('builds a fresh child for every string property', () => {
      const log = createLogger(null, 'System', recordingHandler([]));
      expect(log.a.name).to.equal('a');
      expect(log.a.b!.c!.name).to.equal('a->b->c');
    });

    it('reads one object key through Reflect as its converted string name', () => {
      // Reflect.get converts an object key to a string before the proxy sees it, so the
      // WeakMap branch of the handler stays unreachable: every read arrives as a string.
      const log = createLogger(null, 'System', recordingHandler([]));
      const key = { name: 'byRef' };
      const first = Reflect.get(log as unknown as object, key as unknown as PropertyKey) as { name: string };
      expect(first.name).to.equal('[object Object]');
    });

    it('throws on a symbol property access, because a symbol is no valid name', () => {
      const log = createLogger(null, 'System', recordingHandler([]));
      expect(() => (log as unknown as Record<symbol, unknown>)[Symbol('x')]).to.throw('name is not a string.');
    });
  });

  describe('valueToString and mapArgsToString', () => {
    it('passes strings through', () => {
      expect(valueToString('text')).to.equal('text');
    });

    it('renders undefined as its name', () => {
      expect(valueToString(undefined)).to.equal('undefined');
    });

    it('stringifies one error with its message getter read', () => {
      const error = new Error('boom');
      const rendered = valueToString(error);
      expect(rendered).to.contain('boom');
      expect(rendered).to.contain('stack');
    });

    it('renders one plain object through its toString form', () => {
      expect(valueToString({ a: 1 })).to.equal('[object Object]');
    });

    it('falls back to the error text of one circular structure without toString', () => {
      const circular = Object.create(null) as Record<string, unknown>;
      circular.self = circular;
      expect(valueToString(circular)).to.contain('circular');
    });

    it('maps every argument of one array', () => {
      expect(mapArgsToString(['a', 1])).to.deep.equal(['a', '1']);
    });

    it('throws when the arguments do not come as an array', () => {
      expect(() => mapArgsToString('no-array' as unknown as unknown[])).to.throw('args must be an array.');
    });
  });

  describe('countRe', () => {
    it('counts every match of one global expression', () => {
      expect(countRe('a%sb%co%d', '%[cdso]')).to.equal(3);
    });

    it('turns a non-global expression global for the count', () => {
      expect(countRe('xaxa', /a/)).to.equal(2);
    });

    it('returns zero when nothing matches', () => {
      expect(countRe('plain', /\d/)).to.equal(0);
    });

    it('throws when the expression is missing', () => {
      expect(() => countRe('s', undefined as unknown as RegExp)).to.throw('Missing Regex!');
    });
  });
});
