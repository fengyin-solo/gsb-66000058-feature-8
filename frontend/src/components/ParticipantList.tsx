import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getRoomParticipants, getRoomById, heartbeat } from '../services/interviewRoomService';
import { subscribeParticipants, sendHeartbeat, connect, disconnect } from '../services/websocketService';
import { useInterviewStore } from '../store/interview';
import { ParticipantStatus, getRoomStatusConfig, formatTime } from '../types';
import { useRoomStatusActions } from '../hooks/useRoomStatusActions';
import { checkStartReadiness } from '../utils/roomStatus';

const formatTimeAgo = (dateString: string): string => {
  const now = new Date().getTime();
  const date = new Date(dateString).getTime();
  const diff = now - date;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  if (hours < 24) return `${hours}小时前`;
  return `${days}天前`;
};

interface JoinedNotification {
  id: string;
  name: string;
}

interface ParticipantListProps {
  roomId: string;
}

const ParticipantList: React.FC<ParticipantListProps> = ({ roomId }) => {
  const { currentUser, participants, setParticipants, currentRoom, setCurrentRoom, invitations } = useInterviewStore();
  const [copied, setCopied] = useState(false);
  const [joinedNotification, setJoinedNotification] = useState<JoinedNotification | null>(null);
  const { pendingAction, requestStart, endInterview, resumeInterview } = useRoomStatusActions(roomId);
  const prevParticipantsRef = useRef<ParticipantStatus[]>([]);
  const notificationTimerRef = useRef<number | null>(null);

  const fetchParticipants = useCallback(async () => {
    try {
      const data = await getRoomParticipants(roomId);
      setParticipants(data);
    } catch (error) {
      console.error('Failed to fetch participants:', error);
    }
  }, [roomId, setParticipants]);

  const fetchRoomDetails = useCallback(async () => {
    try {
      const data = await getRoomById(roomId);
      setCurrentRoom(data);
    } catch (error) {
      console.error('Failed to fetch room details:', error);
    }
  }, [roomId, setCurrentRoom]);

  const sendHttpHeartbeat = useCallback(async () => {
    if (!currentUser) return;
    try {
      await heartbeat(roomId, currentUser.id);
    } catch (error) {
      console.error('Failed to send heartbeat:', error);
    }
  }, [roomId, currentUser]);

  // 开始前先做就绪检查（题目 + 候选人在线），缺项时保持等待并提示
  const handleStartInterview = () => {
    if (!currentRoom || pendingAction) return;
    const readiness = checkStartReadiness(currentRoom, participants);
    if (!readiness.ready) return;
    requestStart();
  };

  const handleEndInterview = () => {
    if (pendingAction) return;
    endInterview();
  };

  const handleResumeInterview = () => {
    if (pendingAction) return;
    resumeInterview();
  };

  const handleCopyRoomCode = async () => {
    if (!currentRoom?.roomCode) return;
    try {
      await navigator.clipboard.writeText(currentRoom.roomCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy room code:', error);
    }
  };

  const handleCloseNotification = () => {
    setJoinedNotification(null);
    if (notificationTimerRef.current) {
      clearTimeout(notificationTimerRef.current);
      notificationTimerRef.current = null;
    }
  };

  useEffect(() => {
    const prevParticipants = prevParticipantsRef.current;
    const currentParticipants = participants;

    if (prevParticipants.length > 0 && currentParticipants.length > 0) {
      const prevCandidateIds = new Set(
        prevParticipants
          .filter((p) => p.userRole === 'CANDIDATE' && p.isOnline)
          .map((p) => p.userId)
      );

      const newOnlineCandidates = currentParticipants.filter(
        (p) => p.userRole === 'CANDIDATE' && p.isOnline && !prevCandidateIds.has(p.userId)
      );

      if (newOnlineCandidates.length > 0) {
        const candidate = newOnlineCandidates[0];
        setJoinedNotification({ id: candidate.id, name: candidate.userName });

        if (notificationTimerRef.current) {
          clearTimeout(notificationTimerRef.current);
        }
        notificationTimerRef.current = setTimeout(() => {
          setJoinedNotification(null);
          notificationTimerRef.current = null;
        }, 3000);
      }
    } else if (prevParticipants.length === 0 && currentParticipants.length > 0) {
      const onlineCandidates = currentParticipants.filter(
        (p) => p.userRole === 'CANDIDATE' && p.isOnline
      );
      if (onlineCandidates.length > 0) {
        const candidate = onlineCandidates[0];
        setJoinedNotification({ id: candidate.id, name: candidate.userName });

        if (notificationTimerRef.current) {
          clearTimeout(notificationTimerRef.current);
        }
        notificationTimerRef.current = setTimeout(() => {
          setJoinedNotification(null);
          notificationTimerRef.current = null;
        }, 3000);
      }
    }

    prevParticipantsRef.current = currentParticipants;

    return () => {
      if (notificationTimerRef.current) {
        clearTimeout(notificationTimerRef.current);
      }
    };
  }, [participants]);

  const getInvitationForParticipant = (participant: ParticipantStatus) => {
    return invitations.find(
      (inv) => inv.candidateEmail === participant.userName || inv.candidateName === participant.userName
    );
  };

  const isRecentlyJoined = (joinedAt: string): boolean => {
    const now = new Date().getTime();
    const joined = new Date(joinedAt).getTime();
    return now - joined < 60 * 1000;
  };

  const isInterviewer = currentUser?.role === 'INTERVIEWER';

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      await Promise.all([fetchParticipants(), fetchRoomDetails()]);
      
      if (currentUser) {
        try {
          await connect(roomId, currentUser);
        } catch (error) {
          console.error('WebSocket connection failed:', error);
        }
      }
    };

    init();

    const pollInterval = setInterval(() => {
      if (mounted) {
        fetchParticipants();
        fetchRoomDetails();
      }
    }, 2000);

    const heartbeatInterval = setInterval(() => {
      if (mounted) {
        sendHttpHeartbeat();
        if (currentUser) {
          sendHeartbeat(roomId, currentUser);
        }
      }
    }, 30000);

    let unsubscribe: (() => void) | null = null;
    const setupSubscription = () => {
      unsubscribe = subscribeParticipants(roomId, (data) => {
        if (mounted) {
          setParticipants(data);
        }
      });
    };
    setTimeout(setupSubscription, 1000);

    return () => {
      mounted = false;
      clearInterval(pollInterval);
      clearInterval(heartbeatInterval);
      if (unsubscribe) {
        unsubscribe();
      }
      disconnect();
    };
  }, [roomId, currentUser, fetchParticipants, fetchRoomDetails, sendHttpHeartbeat, setParticipants]);

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

        @keyframes pulse {
          0%, 100% {
            box-shadow: 0 0 8px #4caf50;
          }
          50% {
            box-shadow: 0 0 20px #4caf50, 0 0 30px #4caf50;
          }
        }

        @keyframes cardPulse {
          0%, 100% {
            box-shadow: 0 0 5px rgba(33, 150, 243, 0.3);
          }
          50% {
            box-shadow: 0 0 15px rgba(33, 150, 243, 0.6), 0 0 25px rgba(33, 150, 243, 0.4);
          }
        }

        @keyframes onlinePulse {
          0%, 100% {
            box-shadow: 0 0 6px #4caf50;
            transform: scale(1);
          }
          50% {
            box-shadow: 0 0 12px #4caf50, 0 0 18px #4caf50;
            transform: scale(1.1);
          }
        }

        .notification-bar {
          animation: slideInDown 0.3s ease-out;
        }

        .candidate-card-online {
          animation: cardPulse 2s ease-in-out infinite;
        }

        .online-indicator {
          animation: onlinePulse 1.5s ease-in-out infinite;
        }
      `}</style>

      {joinedNotification && (
        <div
          className="notification-bar"
          style={{
            position: 'fixed',
            top: '20px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            backgroundColor: '#2196f3',
            color: '#fff',
            padding: '12px 24px',
            borderRadius: '8px',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            fontSize: '14px',
            fontWeight: 500,
            minWidth: '280px',
          }}
        >
          <span style={{ flex: 1 }}>
            候选人 {joinedNotification.name} 已加入面试
          </span>
          <button
            onClick={handleCloseNotification}
            style={{
              background: 'none',
              border: 'none',
              color: '#fff',
              fontSize: '18px',
              cursor: 'pointer',
              padding: '0 4px',
              lineHeight: 1,
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

      <div style={{
        backgroundColor: '#1e1e1e',
        borderRadius: '8px',
        padding: '16px',
        color: '#e0e0e0',
        minWidth: '280px',
        position: 'relative',
      }}>
        {currentRoom && (
          <div style={{ marginBottom: '16px' }}>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '12px',
            }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
                {currentRoom.title}
              </h3>
              <span style={{
                padding: '4px 12px',
                borderRadius: '12px',
                fontSize: '12px',
                fontWeight: 500,
                backgroundColor: getRoomStatusConfig(currentRoom.status).bgColor,
                color: getRoomStatusConfig(currentRoom.status).color,
                border: '1px solid ' + getRoomStatusConfig(currentRoom.status).color + '40',
              }}>
                {getRoomStatusConfig(currentRoom.status).icon} {getRoomStatusConfig(currentRoom.status).label}
              </span>
            </div>

            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '12px',
              padding: '8px 12px',
              backgroundColor: '#2a2a2a',
              borderRadius: '6px',
            }}>
              <span style={{ fontSize: '13px', color: '#999' }}>房间码:</span>
              <span style={{
                fontFamily: 'monospace',
                fontSize: '14px',
                fontWeight: 600,
                letterSpacing: '2px',
                flex: 1,
              }}>
                {currentRoom.roomCode}
              </span>
              <button
                onClick={handleCopyRoomCode}
                style={{
                  padding: '4px 12px',
                  fontSize: '12px',
                  backgroundColor: copied ? '#4caf50' : '#3a3a3a',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  transition: 'background-color 0.2s',
                }}
              >
                {copied ? '已复制' : '复制'}
              </button>
            </div>

            {isInterviewer && (
              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                {currentRoom.status === 'WAITING' && (() => {
                  const readiness = checkStartReadiness(currentRoom, participants);
                  return (
                    <button
                      onClick={handleStartInterview}
                      disabled={!!pendingAction}
                      title={readiness.ready ? '开始面试' : `暂不能开始：${readiness.missing.join('；')}`}
                      style={{
                        flex: 1,
                        padding: '10px 16px',
                        fontSize: '14px',
                        fontWeight: 500,
                        backgroundColor: readiness.ready ? '#4caf50' : '#555',
                        color: '#fff',
                        border: 'none',
                        borderRadius: '6px',
                        cursor: pendingAction ? 'not-allowed' : 'pointer',
                        opacity: pendingAction ? 0.7 : 1,
                        transition: 'background-color 0.2s',
                      }}
                    >
                      {pendingAction === 'ACTIVE' ? '开始中...' : readiness.ready ? '开始面试' : '等待就绪'}
                    </button>
                  );
                })()}
                {currentRoom.status === 'ACTIVE' && (
                  <button
                    onClick={handleEndInterview}
                    disabled={!!pendingAction}
                    style={{
                      flex: 1,
                      padding: '10px 16px',
                      fontSize: '14px',
                      fontWeight: 500,
                      backgroundColor: '#f44336',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: pendingAction ? 'not-allowed' : 'pointer',
                      opacity: pendingAction ? 0.7 : 1,
                      transition: 'background-color 0.2s',
                    }}
                  >
                    {pendingAction === 'COMPLETED' ? '结束中...' : '结束面试'}
                  </button>
                )}
                {currentRoom.status === 'COMPLETED' && (
                  <button
                    onClick={handleResumeInterview}
                    disabled={!!pendingAction}
                    title="恢复为进行中，代码与面试记录将保留"
                    style={{
                      flex: 1,
                      padding: '10px 16px',
                      fontSize: '14px',
                      fontWeight: 500,
                      backgroundColor: '#4caf50',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: pendingAction ? 'not-allowed' : 'pointer',
                      opacity: pendingAction ? 0.7 : 1,
                      transition: 'background-color 0.2s',
                    }}
                  >
                    {pendingAction === 'ACTIVE' ? '恢复中...' : '恢复进行中'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div>
          <h4 style={{
            margin: '0 0 12px 0',
            fontSize: '14px',
            fontWeight: 500,
            color: '#999',
          }}>
            参与者 ({participants.length})
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {participants.map((participant) => {
              const isCandidate = participant.userRole === 'CANDIDATE';
              const isHighlighted = isInterviewer && isCandidate;
              const isCurrentUser = currentUser?.id === participant.userId;
              const isOnline = participant.isOnline;
              const isNew = isRecentlyJoined(participant.joinedAt);
              const invitation = getInvitationForParticipant(participant);

              return (
                <div
                  key={participant.id}
                  className={isCandidate && isOnline ? 'candidate-card-online' : ''}
                  style={{
                    padding: '12px',
                    backgroundColor: isHighlighted ? '#2a3f4f' : '#2a2a2a',
                    borderRadius: '6px',
                    border: isHighlighted ? '1px solid #2196f3' : '1px solid transparent',
                    transition: 'all 0.2s',
                  }}
                >
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    marginBottom: '8px',
                    flexWrap: 'wrap',
                  }}>
                    <div
                      className={isOnline ? 'online-indicator' : ''}
                      style={{
                        width: '10px',
                        height: '10px',
                        borderRadius: '50%',
                        backgroundColor: isOnline ? '#4caf50' : '#666',
                        boxShadow: isOnline ? '0 0 8px #4caf50' : 'none',
                        flexShrink: 0,
                      }}
                    />
                    <span style={{
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '11px',
                      fontWeight: 500,
                      backgroundColor: participant.userRole === 'INTERVIEWER' ? '#9c27b0' : '#2196f3',
                      color: '#fff',
                    }}>
                      {participant.userRole === 'INTERVIEWER' ? '面试官' : '候选人'}
                    </span>
                    <span style={{
                      fontWeight: 500,
                      fontSize: '14px',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {participant.userName}
                      {isCurrentUser && <span style={{ color: '#999', marginLeft: '4px' }}>（我）</span>}
                    </span>
                    {isCandidate && isNew && (
                      <span style={{
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        fontWeight: 600,
                        backgroundColor: '#ff9800',
                        color: '#fff',
                        marginLeft: 'auto',
                      }}>
                        刚加入
                      </span>
                    )}
                    {invitation && invitation.status === 'JOINED' && (
                      <span style={{
                        color: '#4caf50',
                        fontSize: '14px',
                        marginLeft: '4px',
                      }}>
                        ✓
                      </span>
                    )}
                  </div>
                  <div style={{
                    fontSize: '12px',
                    color: '#888',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                  }}>
                    <span>加入时间: {formatTime(participant.joinedAt)} ({formatTimeAgo(participant.joinedAt)})</span>
                    <span>最后活跃: {formatTime(participant.lastHeartbeat)}</span>
                    {invitation && (
                      <span>
                        邀请状态: 
                        <span style={{
                          color: invitation.status === 'JOINED' ? '#4caf50' : '#ff9800',
                          marginLeft: '4px',
                        }}>
                          {invitation.status === 'JOINED' ? '已加入' : invitation.status}
                        </span>
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
};

export default ParticipantList;
