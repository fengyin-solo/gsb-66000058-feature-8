import { useState, useCallback, useRef } from 'react';
import { updateRoomStatus } from '../services/interviewRoomService';
import { useInterviewStore } from '../store/interview';
import { useToastStore } from '../store/toast';
import {
  RoomStatus,
  assertTransition,
  checkStartReadiness,
  StartReadiness,
} from '../utils/roomStatus';

/**
 * 面试官房间的状态流转操作（开始 / 结束 / 恢复）。
 * - 所有流转先经前端状态机校验，重复点击或非法倒退直接拒绝；
 * - 请求进行中加锁，避免重复提交；
 * - 开始前先做题目与候选人就绪检查，缺项时保持等待并指出缺项；
 * - 恢复进行中不清理代码、语言与执行记录（store 中均保留）。
 */
export const useRoomStatusActions = (roomId: string) => {
  const { currentRoom, participants, setCurrentRoom } = useInterviewStore();
  const toast = useToastStore();
  const [pendingAction, setPendingAction] = useState<RoomStatus | null>(null);
  const pendingActionRef = useRef<RoomStatus | null>(null);

  const getReadiness = useCallback((): StartReadiness => {
    return checkStartReadiness(currentRoom, participants);
  }, [currentRoom, participants]);

  const transitionTo = useCallback(async (target: RoomStatus): Promise<boolean> => {
    if (!currentRoom) return false;

    // 防重复点击：同一流转正在进行时直接忽略
    if (pendingActionRef.current) return false;

    try {
      assertTransition(currentRoom.status, target);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '当前状态不允许该操作');
      return false;
    }

    pendingActionRef.current = target;
    setPendingAction(target);
    try {
      const updatedRoom = await updateRoomStatus(roomId, target);
      setCurrentRoom(updatedRoom);
      return true;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '状态更新失败，请稍后重试');
      return false;
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  }, [currentRoom, roomId, setCurrentRoom, toast]);

  /** 开始前入口：未就绪时保持等待并提示缺项；就绪后才真正流转 */
  const requestStart = useCallback(async (): Promise<boolean> => {
    const readiness = checkStartReadiness(currentRoom, participants);
    if (!readiness.ready) {
      toast.warning(`暂不能开始面试：${readiness.missing.join('；')}`);
      return false;
    }
    return transitionTo('ACTIVE');
  }, [currentRoom, participants, toast, transitionTo]);

  const endInterview = useCallback(() => transitionTo('COMPLETED'), [transitionTo]);
  const resumeInterview = useCallback(() => transitionTo('ACTIVE'), [transitionTo]);

  return {
    pendingAction,
    getReadiness,
    requestStart,
    startInterview: () => transitionTo('ACTIVE'),
    endInterview,
    resumeInterview,
  };
};
