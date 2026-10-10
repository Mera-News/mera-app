import { a, c, d, e, type T } from '@/lib/barrel';
import type { T as T2 } from './barrel';
import { a as onlyA } from '@/lib/barrel';
import { Dflt, a as a3 } from '@/lib/barrel/index';

export { d as dd, e as ee } from '@/lib/barrel';
export * from './barrel';
export const lazyA = () => require('@/lib/barrel').a;
export const { a: aa } = require('@/lib/barrel');
export type TT = typeof import('@/lib/barrel').T;
export { a, c, d, e, T, T2, onlyA, Dflt, a3 };
