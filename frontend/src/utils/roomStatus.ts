import type { InterviewRoom, ParticipantStatus } from '../types';

export type RoomStatus = InterviewRoom['status'];

/**
 * 允许的房间状态流转：
 * WAITING  -> ACTIVE / CANCELLED （开始前确认通过后才能开始）
 * ACTIVE   -> COMPLETED          （结束）
 * COMPLETED -> ACTIVE            （误结束后恢复，保留代码与面试记录）
 * 目标状态与当前状态相同视为幂等，重复点击不会导致状态倒退。
 */
const ALLOWED_TRANSITIONS: Record<RoomStatus, RoomStatus[]> = {
  WAITING: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['COMPLETED'],
  COMPLETED: ['ACTIVE'],
  CANCELLED: [],
};

/** 判断当前状态是否允许流转到目标状态（相同状态按幂等处理） */
export const canTransition = (current: string, target: string): boolean => {
  if (current === target) return true;
  return (ALLOWED_TRANSITIONS[current as RoomStatus] || []).includes(target as RoomStatus);
};

export interface RoomStatusError extends Error {
  status?: number;
}

/** 执行一次房间状态流转，非法流转直接拒绝，不向后端发请求（防止状态倒退） */
export const assertTransition = (current: string, target: RoomStatus): void => {
  if (!canTransition(current, target)) {
    const error: RoomStatusError = new Error(getRejectedMessage(current, target));
    error.status = 409;
    throw error;
  }
};

/** 与后端返回文案保持一致的非法流转提示 */
export const getRejectedMessage = (current: string, target: string): string => {
  if (target === 'ACTIVE' && current === 'COMPLETED') {
    return '面试已结束，无法重新开始，如需继续请使用“恢复进行中”';
  }
  if (target === 'COMPLETED' && current === 'WAITING') {
    return '面试尚未开始，无法结束';
  }
  return `当前状态不允许该操作（${current} → ${target}）`;
};

export interface StartReadiness {
  problemReady: boolean;
  candidateReady: boolean;
  ready: boolean;
  /** 未就绪项说明，用于在开始前确认面板中逐项指出缺项 */
  missing: string[];
}

/** 开始前就绪检查：题目已配置，且候选人已在线 */
export const checkStartReadiness = (
  room: InterviewRoom | null,
  participants: ParticipantStatus[],
): StartReadiness => {
  const problemReady = !!room?.problemId;
  const candidateReady = participants.some(
    (p) => p.userRole === 'CANDIDATE' && p.isOnline,
  );

  const missing: string[] = [];
  if (!problemReady) missing.push('题目未配置，请先为房间选择面试题目');
  if (!candidateReady) missing.push('候选人尚未进入房间，请等待候选人加入');

  return {
    problemReady,
    candidateReady,
    ready: problemReady && candidateReady,
    missing,
  };
};
