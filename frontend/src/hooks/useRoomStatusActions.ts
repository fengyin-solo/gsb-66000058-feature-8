import { useCallback, useEffect } from 'react';
import { useInterviewStore } from '../store/interview';
import { updateRoomStatus } from '../services/interviewRoomService';
import { InterviewRoom, RoomMissingItem, RoomStatusErrorBody } from '../types';

/**
 * 面试房间状态流转：
 * - 开始前确认：题目与候选人未就绪时保持等待并给出缺项
 * - 结束后恢复：误操作结束时可恢复为进行中，代码与面试记录保留在本地状态中不被清除
 * - 幂等防重：流转请求进行中或当前状态不匹配时忽略重复操作，状态不会倒退
 */
export function useRoomStatusActions() {
  const {
    currentRoom,
    currentProblem,
    participants,
    setCurrentRoom,
    roomStatusUpdating,
    setRoomStatusUpdating,
    roomMissingItems,
    setRoomMissingItems,
  } = useInterviewStore();

  const computeMissingItems = useCallback((): RoomMissingItem[] => {
    const missing: RoomMissingItem[] = [];
    if (!currentRoom?.problemId || !currentProblem) {
      missing.push('PROBLEM');
    }
    if (!participants.some((p) => p.userRole === 'CANDIDATE')) {
      missing.push('CANDIDATE');
    }
    return missing;
  }, [currentRoom, currentProblem, participants]);

  // 缺项在条件补齐后自动消除（例如候选人入场后提示自动消失）
  useEffect(() => {
    if (roomMissingItems.length === 0) return;
    const stillMissing = computeMissingItems();
    const next = roomMissingItems.filter((item) => stillMissing.includes(item));
    if (next.length !== roomMissingItems.length) {
      setRoomMissingItems(next);
    }
  }, [roomMissingItems, computeMissingItems, setRoomMissingItems]);

  const applyStatus = useCallback(
    async (targetStatus: InterviewRoom['status'], expectedCurrent: InterviewRoom['status']): Promise<boolean> => {
      if (!currentRoom || roomStatusUpdating) return false;
      // 防止重复点击或过期界面把状态倒退
      if (currentRoom.status !== expectedCurrent) return false;

      setRoomStatusUpdating(true);
      try {
        const updatedRoom = await updateRoomStatus(currentRoom.id, targetStatus);
        setCurrentRoom(updatedRoom);
        setRoomMissingItems([]);
        return true;
      } catch (error: any) {
        const body = error?.body as RoomStatusErrorBody | null | undefined;
        if (body?.missingItems && body.missingItems.length > 0) {
          // 服务端就绪检查未通过：保持等待并指出缺项
          setRoomMissingItems(body.missingItems);
        } else {
          console.error('Failed to update room status:', error);
        }
        return false;
      } finally {
        setRoomStatusUpdating(false);
      }
    },
    [currentRoom, roomStatusUpdating, setCurrentRoom, setRoomStatusUpdating, setRoomMissingItems]
  );

  const startInterview = useCallback(async (): Promise<boolean> => {
    if (!currentRoom || currentRoom.status !== 'WAITING' || roomStatusUpdating) return false;
    // 本地预检，未就绪时不发请求，直接指出缺项
    const missing = computeMissingItems();
    if (missing.length > 0) {
      setRoomMissingItems(missing);
      return false;
    }
    return applyStatus('ACTIVE', 'WAITING');
  }, [currentRoom, roomStatusUpdating, computeMissingItems, setRoomMissingItems, applyStatus]);

  const endInterview = useCallback(async (): Promise<boolean> => {
    return applyStatus('COMPLETED', 'ACTIVE');
  }, [applyStatus]);

  const restoreInterview = useCallback(async (): Promise<boolean> => {
    return applyStatus('ACTIVE', 'COMPLETED');
  }, [applyStatus]);

  const dismissMissingItems = useCallback(() => {
    setRoomMissingItems([]);
  }, [setRoomMissingItems]);

  return {
    startInterview,
    endInterview,
    restoreInterview,
    isUpdating: roomStatusUpdating,
    missingItems: roomMissingItems,
    dismissMissingItems,
  };
}
