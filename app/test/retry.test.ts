// P1-B (independent audit): Retry on a failed job runs it again, without needing another job to start the runner.
import { describe, expect, it, vi } from 'vitest';

const render = vi.fn();
vi.mock('../src/engine', () => ({ engine: { render } }));
vi.mock('../src/qol/qol', () => ({ asError: (e: unknown) => ({ toJSON: () => ({ humanMessage: String(e) }) }), toast: () => {}, toastError: () => {} }));
vi.mock('../src/state/ui', () => ({ setUi: () => {}, settingsStore: { get: () => ({ paths: { output: 'D:\out' } }) } }));
vi.mock('../src/state/project', () => ({ getDoc: () => ({}) })); // queueRender's; addJob does not read the project
vi.mock('../src/host', () => ({ host: {} }));
const { addJob, renderStore, retryJob } = await import('../src/state/render');

const settle = () => new Promise((r) => setTimeout(r, 20));
const ok = () => ({ promise: Promise.resolve(), cancel: () => {} });

describe('retryJob', () => {
  it('re-runs a failed job straight away', async () => {
    render.mockReturnValueOnce({ promise: Promise.reject(new Error('boom')), cancel: () => {} }).mockReturnValueOnce(ok());
    await addJob('r', { format: 'h264' } as never, 'D:\out');
    await settle();
    const id = renderStore.get()[0].id;
    expect(renderStore.get()[0].status).toBe('failed');
    retryJob(id);
    await settle();
    expect(render).toHaveBeenCalledTimes(2);
    expect(renderStore.get()[0].status).toBe('done');
  });
});
