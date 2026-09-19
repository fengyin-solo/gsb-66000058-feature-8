import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { CodeEditor } from './CodeEditor';
import { ProblemPanel } from './ProblemPanel';
import { CreateRoomModal } from './CreateRoomModal';
import { InvitePanel } from './InvitePanel';
import ParticipantList from './ParticipantList';
import { useInterviewStore, StatusChangeNotification } from '../store/interview';
import { ParticipantStatus, getRoomStatusConfig, formatDuration, formatTime, ROOM_MISSING_ITEM_LABELS } from '../types';
import { getRoomById, getRoomParticipants, heartbeat } from '../services/interviewRoomService';
import { connect, disconnect, subscribeParticipants, subscribeRoomStatus, sendHeartbeat } from '../services/websocketService';
import { getProblemById } from '../services/problemService';
import { useRoomStatusActions } from '../hooks/useRoomStatusActions';

export const InterviewerRoomView: React.FC = () => {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const {
    currentRoom,
    currentUser,
    currentProblem,
    setCurrentRoom,
    setParticipants,
    updateParticipant,
    setIsConnected,
    resetRoom,
    setProblem,
    statusChangeNotification,
    setStatusChangeNotification,
  } = useInterviewStore();
  const [showInvitePanel, setShowInvitePanel] = useState(true);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [duration, setDuration] = useState<string>('');
  const [localStatusNotification, setLocalStatusNotification] = useState<StatusChangeNotification | null>(null);
  const {
    startInterview,
    endInterview,
    restoreInterview,
    isUpdating: isStatusUpdating,
    missingItems,
    dismissMissingItems,
  } = useRoomStatusActions();
  const httpHeartbeatRef = useRef<number | null>(null);
  const wsHeartbeatRef = useRef<number | null>(null);
  const unsubscribeParticipantsRef = useRef<(() => void) | null>(null);
  const unsubscribeRoomStatusRef = useRef<(() => void) | null>(null);
  const durationTimerRef = useRef<number | null>(null);
  const notificationTimerRef = useRef<number | null>(null);

  const fetchRoomDetails = useCallback(async () => {
    if (!roomId) return;
    try {
      const data = await getRoomById(roomId);
      setCurrentRoom(data);
      if (data.problemId) {
        const problem = await getProblemById(data.problemId);
        setProblem(problem);
      }
    } catch (error) {
      console.error('Failed to fetch room details:', error);
    }
  }, [roomId, setCurrentRoom, setProblem]);

  const fetchParticipants = useCallback(async () => {
    if (!roomId) return;
    try {
      const data = await getRoomParticipants(roomId);
      setParticipants(data);
    } catch (error) {
      console.error('Failed to fetch participants:', error);
    }
  }, [roomId, setParticipants]);

  const sendHttpHeartbeat = useCallback(async () => {
    if (!roomId || !currentUser) return;
    try {
      const participant = await heartbeat(roomId, currentUser.id);
      updateParticipant(participant);
    } catch (error) {
      console.error('Failed to send heartbeat:', error);
    }
  }, [roomId, currentUser, updateParticipant]);

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      setLoading(true);
      try {
        if (!currentRoom && roomId) {
          await fetchRoomDetails();
        }
        await fetchParticipants();

        if (currentUser && roomId) {
          try {
            await connect(roomId, currentUser);
            setIsConnected(true);

            unsubscribeParticipantsRef.current = subscribeParticipants(roomId, (data) => {
              if (mounted) {
                setParticipants(data as ParticipantStatus[]);
              }
            });

            unsubscribeRoomStatusRef.current = subscribeRoomStatus(roomId, (room) => {
              if (mounted) {
                setCurrentRoom(room);
              }
            });

            httpHeartbeatRef.current = window.setInterval(sendHttpHeartbeat, 30000);
            wsHeartbeatRef.current = window.setInterval(() => {
              if (currentUser) sendHeartbeat(roomId, currentUser);
            }, 30000);
          } catch (error) {
            console.error('Failed to connect WebSocket:', error);
          }
        }
      } catch (error) {
        console.error('Failed to initialize room:', error);
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    init();

    return () => {
      mounted = false;
      if (httpHeartbeatRef.current) clearInterval(httpHeartbeatRef.current);
      if (wsHeartbeatRef.current) clearInterval(wsHeartbeatRef.current);
      if (unsubscribeParticipantsRef.current) unsubscribeParticipantsRef.current();
      if (unsubscribeRoomStatusRef.current) unsubscribeRoomStatusRef.current();
      disconnect();
      setIsConnected(false);
    };
  }, [roomId, currentUser, currentRoom, fetchRoomDetails, fetchParticipants, sendHttpHeartbeat, setIsConnected, setCurrentRoom, setParticipants]);

  const updateDuration = useCallback(() => {
    if (!currentRoom) return;
    if (currentRoom.status === 'WAITING') {
      setDuration(formatDuration(currentRoom.createdAt));
    } else if (currentRoom.status === 'ACTIVE' && currentRoom.startedAt) {
      setDuration(formatDuration(currentRoom.startedAt));
    } else if (currentRoom.status === 'COMPLETED' && currentRoom.startedAt && currentRoom.endedAt) {
      setDuration(formatDuration(currentRoom.startedAt, currentRoom.endedAt));
    }
  }, [currentRoom]);

  useEffect(() => {
    updateDuration();
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
    }
    if (currentRoom && (currentRoom.status === 'WAITING' || currentRoom.status === 'ACTIVE')) {
      durationTimerRef.current = window.setInterval(updateDuration, 1000);
    }
    return () => {
      if (durationTimerRef.current) {
        clearInterval(durationTimerRef.current);
      }
    };
  }, [currentRoom?.status, currentRoom?.createdAt, currentRoom?.startedAt, currentRoom?.endedAt, updateDuration]);

  useEffect(() => {
    if (statusChangeNotification) {
      setLocalStatusNotification(statusChangeNotification);
      setStatusChangeNotification(null);
      if (notificationTimerRef.current) {
        clearTimeout(notificationTimerRef.current);
      }
      notificationTimerRef.current = window.setTimeout(() => {
        setLocalStatusNotification(null);
        notificationTimerRef.current = null;
      }, 5000);
    }
    return () => {
      if (notificationTimerRef.current) {
        clearTimeout(notificationTimerRef.current);
      }
    };
  }, [statusChangeNotification, setStatusChangeNotification]);

  const getStatusDurationLabel = () => {
    if (!currentRoom) return '';
    switch (currentRoom.status) {
      case 'WAITING': return `已等待 ${duration}`;
      case 'ACTIVE': return `已进行 ${duration}`;
      case 'COMPLETED': return `面试时长 ${duration}`;
      default: return '';
    }
  };

  const closeStatusNotification = () => {
    setLocalStatusNotification(null);
    if (notificationTimerRef.current) {
      clearTimeout(notificationTimerRef.current);
      notificationTimerRef.current = null;
    }
  };

  const handleStartInterview = async () => {
    await startInterview();
  };

  const handleEndInterview = async () => {
    await endInterview();
  };

  const handleRestoreInterview = async () => {
    await restoreInterview();
  };

  const handleBack = () => {
    resetRoom();
    navigate('/');
  };

  if (loading) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: '#0d0d0d',
      }}>
        <div style={{ color: '#fff', fontSize: '16px' }}>加载中...</div>
      </div>
    );
  }

  if (!currentRoom) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: '#0d0d0d',
        flexDirection: 'column',
        gap: '16px',
      }}>
        <div style={{ color: '#f44336', fontSize: '16px' }}>房间不存在</div>
        <button
          onClick={handleBack}
          style={{
            padding: '10px 24px',
            background: '#2196f3',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
          }}>
          返回首页
        </button>
      </div>
    );
  }

  if (!currentProblem) {
    return (
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100vh',
        background: '#0d0d0d',
        flexDirection: 'column',
        gap: '16px',
      }}>
        <div style={{ color: '#ff9800', fontSize: '16px' }}>题目加载失败，请稍后重试</div>
        <button
          onClick={handleBack}
          style={{
            padding: '10px 24px',
            background: '#2196f3',
            color: '#fff',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
          }}>
          返回首页
        </button>
      </div>
    );
  }

  const statusConfig = currentRoom ? getRoomStatusConfig(currentRoom.status) : null;

  return (
    <>
      <style>{`
        @keyframes slideInDown {
          from {
            transform: translateY(-100%);
            opacity: 0;
          }
          to {
            transform: translateY(0);
            opacity: 1;
          }
        }
        @keyframes pulse-ring {
          0% {
            transform: scale(0.8);
            opacity: 1;
          }
          50% {
            transform: scale(1.2);
            opacity: 0.5;
          }
          100% {
            transform: scale(0.8);
            opacity: 1;
          }
        }
        @keyframes statusBlink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
        @keyframes statusPulse {
          0%, 100% {
            box-shadow: 0 0 8px currentColor;
          }
          50% {
            box-shadow: 0 0 20px currentColor, 0 0 30px currentColor;
          }
        }
        .status-notification {
          animation: slideInDown 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55);
        }
        .status-indicator-pulse {
          animation: statusPulse 2s ease-in-out infinite;
        }
        .status-blink {
          animation: statusBlink 1.5s ease-in-out infinite;
        }
      `}</style>

      {localStatusNotification && (
        <div
          className="status-notification"
          style={{
            position: 'fixed',
            top: '16px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 9999,
            background: 'linear-gradient(135deg, ' + getRoomStatusConfig(localStatusNotification.newStatus).color + ', ' + getRoomStatusConfig(localStatusNotification.newStatus).color + 'dd)',
            color: '#fff',
            padding: '16px 28px',
            borderRadius: '12px',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.3)',
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            minWidth: '360px',
            border: '1px solid rgba(255, 255, 255, 0.2)',
          }}
        >
          <div style={{
            width: '48px',
            height: '48px',
            borderRadius: '50%',
            background: 'rgba(255, 255, 255, 0.2)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '24px',
          }}>
            {getRoomStatusConfig(localStatusNotification.newStatus).icon}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: '12px', opacity: 0.9, marginBottom: '2px' }}>
              {getRoomStatusConfig(localStatusNotification.oldStatus).label} → {getRoomStatusConfig(localStatusNotification.newStatus).label}
            </div>
            <div style={{ fontSize: '16px', fontWeight: 600 }}>
              面试状态已变更
            </div>
            <div style={{ fontSize: '13px', opacity: 0.9, marginTop: '2px' }}>
              {getRoomStatusConfig(localStatusNotification.newStatus).description}
            </div>
          </div>
          <button
            onClick={closeStatusNotification}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#fff',
              fontSize: '20px',
              cursor: 'pointer',
              padding: '4px 8px',
              opacity: 0.8,
              transition: 'opacity 0.2s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.8')}
          >
            ×
          </button>
        </div>
      )}

    <div style={{ display: 'flex', height: '100vh', fontFamily: 'sans-serif', background: '#0d0d0d' }}>
      <div style={{
        width: '56px',
        background: '#1a1a1a',
        borderRight: '1px solid #333',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '16px 0',
        gap: '16px',
      }}>
        <button
          onClick={handleBack}
          title="返回房间列表"
          style={{
            width: '40px', height: '40px',
            background: 'transparent',
            border: 'none',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '20px',
            borderRadius: '8px',
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = '#333'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}>
          ←
        </button>
        <button
          onClick={() => setShowInvitePanel(!showInvitePanel)}
          title={showInvitePanel ? '隐藏邀请面板' : '显示邀请面板'}
          style={{
            width: '40px', height: '40px',
            background: showInvitePanel ? '#2196f3' : 'transparent',
            border: 'none',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '18px',
            borderRadius: '8px',
          }}
          onMouseEnter={(e) => !showInvitePanel && (e.currentTarget.style.background = '#333')}
          onMouseLeave={(e) => !showInvitePanel && (e.currentTarget.style.background = 'transparent')}>
          👥
        </button>
      </div>

      {showInvitePanel && (
        <InvitePanel roomId={currentRoom.id} roomCode={currentRoom.roomCode} />
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{
          background: '#1e1e1e',
          borderBottom: '1px solid #333',
          padding: '12px 20px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '16px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flex: 1 }}>
            <h2 style={{ color: '#fff', margin: 0, fontSize: '18px', whiteSpace: 'nowrap' }}>{currentRoom.title}</h2>
            {statusConfig && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '6px 14px',
                borderRadius: '20px',
                background: statusConfig.bgColor,
                border: '1px solid ' + statusConfig.color + '40',
              }}>
                <div style={{
                  width: '10px',
                  height: '10px',
                  borderRadius: '50%',
                  background: statusConfig.color,
                  color: statusConfig.color,
                }} className={(currentRoom.status === 'WAITING' || currentRoom.status === 'ACTIVE') ? 'status-indicator-pulse' : ''} />
                <span style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: statusConfig.color,
                }}>
                  {statusConfig.icon} {statusConfig.label}
                </span>
              </div>
            )}
            {statusConfig && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '12px', color: '#666' }}>⏱</span>
                <span style={{
                  fontSize: '12px',
                  color: statusConfig.color,
                  fontWeight: 500,
                  fontFamily: 'monospace',
                }} className={currentRoom.status === 'ACTIVE' ? 'status-blink' : ''}>
                  {getStatusDurationLabel()}
                </span>
              </div>
            )}
            {currentRoom.startedAt && (
              <div style={{ fontSize: '11px', color: '#666' }}>
                开始于 {formatTime(currentRoom.startedAt)}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ color: '#888', fontSize: '13px' }}>
              房间码: <span style={{ color: '#4caf50', fontFamily: 'monospace', fontWeight: 'bold', letterSpacing: '1px' }}>{currentRoom.roomCode}</span>
            </div>
            {currentRoom.status === 'WAITING' && (
              <button
                onClick={handleStartInterview}
                disabled={isStatusUpdating}
                style={{
                  padding: '10px 24px',
                  background: 'linear-gradient(135deg, #4caf50, #45a049)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: isStatusUpdating ? 'not-allowed' : 'pointer',
                  fontSize: '14px',
                  fontWeight: 600,
                  boxShadow: '0 4px 12px rgba(76, 175, 80, 0.3)',
                  transition: 'all 0.2s',
                  opacity: isStatusUpdating ? 0.6 : 1,
                }}
                onMouseEnter={(e) => {
                  if (isStatusUpdating) return;
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = '0 6px 16px rgba(76, 175, 80, 0.4)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(76, 175, 80, 0.3)';
                }}>
                {isStatusUpdating ? '处理中...' : '▶ 开始面试'}
              </button>
            )}
            {currentRoom.status === 'ACTIVE' && (
              <button
                onClick={handleEndInterview}
                disabled={isStatusUpdating}
                style={{
                  padding: '10px 24px',
                  background: 'linear-gradient(135deg, #f44336, #e53935)',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '8px',
                  cursor: isStatusUpdating ? 'not-allowed' : 'pointer',
                  fontSize: '14px',
                  fontWeight: 600,
                  boxShadow: '0 4px 12px rgba(244, 67, 54, 0.3)',
                  transition: 'all 0.2s',
                  opacity: isStatusUpdating ? 0.6 : 1,
                }}
                onMouseEnter={(e) => {
                  if (isStatusUpdating) return;
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = '0 6px 16px rgba(244, 67, 54, 0.4)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(244, 67, 54, 0.3)';
                }}>
                {isStatusUpdating ? '处理中...' : '⏹ 结束面试'}
              </button>
            )}
            {currentRoom.status === 'COMPLETED' && (
              <>
                <div style={{
                  padding: '8px 16px',
                  background: 'rgba(33, 150, 243, 0.1)',
                  border: '1px solid rgba(33, 150, 243, 0.3)',
                  borderRadius: '6px',
                  fontSize: '13px',
                  color: '#2196f3',
                  fontWeight: 500,
                }}>
                  面试已完成 · 可回看代码与记录
                </div>
                <button
                  onClick={handleRestoreInterview}
                  disabled={isStatusUpdating}
                  title="误操作结束时可恢复为进行中，代码与面试记录将保留"
                  style={{
                    padding: '10px 24px',
                    background: 'linear-gradient(135deg, #2196f3, #1e88e5)',
                    color: '#fff',
                    border: 'none',
                    borderRadius: '8px',
                    cursor: isStatusUpdating ? 'not-allowed' : 'pointer',
                    fontSize: '14px',
                    fontWeight: 600,
                    boxShadow: '0 4px 12px rgba(33, 150, 243, 0.3)',
                    transition: 'all 0.2s',
                    opacity: isStatusUpdating ? 0.6 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (isStatusUpdating) return;
                    e.currentTarget.style.transform = 'translateY(-1px)';
                    e.currentTarget.style.boxShadow = '0 6px 16px rgba(33, 150, 243, 0.4)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(33, 150, 243, 0.3)';
                  }}>
                  {isStatusUpdating ? '处理中...' : '↩ 恢复面试'}
                </button>
              </>
            )}
          </div>
        </div>

        {missingItems.length > 0 && currentRoom.status === 'WAITING' && (
          <div style={{
            background: 'rgba(255, 152, 0, 0.12)',
            borderBottom: '1px solid rgba(255, 152, 0, 0.35)',
            padding: '8px 20px',
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
          }}>
            <span style={{ fontSize: '14px' }}>⚠️</span>
            <span style={{ color: '#ffb74d', fontSize: '13px', flex: 1 }}>
              暂不能开始面试，请先确认：
              {missingItems.map((item) => ROOM_MISSING_ITEM_LABELS[item]).join('；')}
            </span>
            <button
              onClick={dismissMissingItems}
              style={{
                background: 'transparent',
                border: 'none',
                color: '#ffb74d',
                fontSize: '16px',
                cursor: 'pointer',
                padding: '0 4px',
                opacity: 0.8,
              }}
              onMouseEnter={(e) => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={(e) => (e.currentTarget.style.opacity = '0.8')}
            >
              ×
            </button>
          </div>
        )}

        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <ProblemPanel problem={currentProblem} />
          <CodeEditor
            disabled={currentRoom.status !== 'ACTIVE'}
          />
        </div>
      </div>

      <div style={{
        width: '320px',
        background: '#1a1a1a',
        borderLeft: '1px solid #333',
        padding: '16px',
        overflowY: 'auto',
      }}>
        <ParticipantList roomId={currentRoom.id} />
      </div>

      <CreateRoomModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onSuccess={() => setIsCreateModalOpen(false)}
      />
    </div>
    </>
  );
};
