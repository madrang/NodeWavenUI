/**
 * Specs for the task payload readers of the core contract: an update that arrives with a damaged
 * checklist or priority names no change, so the store keeps its stored values.
 */

import { expect } from 'chai';
import { readTaskUpdatePayload } from '../../dist/shared/core-api.js';

describe('the task update payload', () => {
  it('keeps the stored checklist and priority when the payload damages them', () => {
    // A checklist that is no list, and a priority that is no number, name no change.
    const damaged = readTaskUpdatePayload({ id: 'task-1', input: { goals: 'The tests pass', priority: 'high' } });
    expect(damaged?.id).to.equal('task-1');
    expect(damaged?.input).to.deep.equal({});
    // An empty list still clears the checklist, and a number still sets the priority.
    const clear = readTaskUpdatePayload({ id: 'task-1', input: { goals: [], priority: 9 } });
    expect(clear?.input).to.deep.equal({ goals: [], priority: 9 });
    // A list that holds something else than text keeps its texts only.
    const mixed = readTaskUpdatePayload({ id: 'task-1', input: { goals: ['The tests pass', 4] } });
    expect(mixed?.input).to.deep.equal({ goals: ['The tests pass'] });
  });
});
