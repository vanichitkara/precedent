import { vi } from 'vitest';

// Forge SDKs look for the Forge runtime at import time; unit tests only cover pure logic.
vi.mock('@forge/sql', () => ({ sql: {}, migrationRunner: { enqueue: () => ({}) } }));
vi.mock('@forge/api', () => ({ default: {}, route: () => '' }));
vi.mock('@forge/events', () => ({ Queue: class {} }));
