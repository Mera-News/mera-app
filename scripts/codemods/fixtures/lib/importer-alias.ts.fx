import { timeAgo } from '@/lib/utils/time-ago';
import type { timeAgo as T } from "@/lib/utils/time-ago";
import { other } from '@/lib/other';

export { timeAgo as again } from '@/lib/utils/time-ago';
export const lazy = () => require('@/lib/utils/time-ago').timeAgo;
export type Mod = typeof import('@/lib/utils/time-ago');
export const dyn = () => import('@/lib/utils/time-ago');
jest.mock('@/lib/other');
export { timeAgo, T, other };
