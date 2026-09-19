import type { InterviewRoom, ParticipantStatus, CreateRoomRequest, CreateRoomResponse, JoinRoomResponse } from '../types';
import { canTransition, getRejectedMessage } from '../utils/roomStatus';

const STORAGE_KEY = 'code_interview_rooms';

const mockRooms: InterviewRoom[] = [];

const loadFromStorage = (): InterviewRoom[] => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.warn('Failed to load rooms from storage:', e);
  }
  return [...mockRooms];
};

const saveToStorage = (rooms: InterviewRoom[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rooms));
  } catch (e) {
    console.warn('Failed to save rooms to storage:', e);
  }
};

let roomsCache: InterviewRoom[] | null = null;

const getRoomsCache = (): InterviewRoom[] => {
  if (!roomsCache) {
    roomsCache = loadFromStorage();
  }
  return roomsCache;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const generateRoomCode = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
};

export async function mockCreateRoom(data: CreateRoomRequest): Promise<CreateRoomResponse> {
  await delay(500);
  const rooms = getRoomsCache();
  const roomId = 'room-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  const roomCode = generateRoomCode();
  const now = new Date().toISOString();

  const newRoom: InterviewRoom = {
    id: roomId,
    roomCode: roomCode,
    title: data.title,
    problemId: data.problemId,
    interviewerId: data.interviewerId,
    candidateId: '',
    status: 'WAITING',
    createdAt: now,
    code: '',
    language: 'javascript',
    chatMessages: [],
  };

  const participant: ParticipantStatus = {
    id: 'participant-' + Date.now(),
    roomId: roomId,
    userId: data.interviewerId,
    userName: data.interviewerName,
    userRole: 'INTERVIEWER',
    isOnline: true,
    lastHeartbeat: now,
    joinedAt: now,
  };

  roomsCache = [newRoom, ...rooms];
  saveToStorage(roomsCache);

  return {
    room: { ...newRoom },
    participant: { ...participant },
  };
}

export async function mockGetRoomById(roomId: string): Promise<InterviewRoom> {
  await delay(200);
  const rooms = getRoomsCache();
  const room = rooms.find(r => r.id === roomId);
  if (!room) {
    throw new Error('房间不存在');
  }
  return { ...room };
}

export async function mockGetRoomByCode(roomCode: string): Promise<InterviewRoom> {
  await delay(200);
  const rooms = getRoomsCache();
  const room = rooms.find(r => r.roomCode === roomCode);
  if (!room) {
    throw new Error('房间不存在');
  }
  return { ...room };
}

export async function mockGetRoomsByInterviewer(interviewerId: string): Promise<InterviewRoom[]> {
  await delay(300);
  const rooms = getRoomsCache();
  return rooms
    .filter(r => r.interviewerId === interviewerId)
    .map(r => ({ ...r }));
}

export async function mockUpdateRoomStatus(roomId: string, status: string): Promise<InterviewRoom> {
  await delay(300);
  const rooms = getRoomsCache();
  const index = rooms.findIndex(r => r.id === roomId);
  if (index === -1) {
    throw new Error('房间不存在');
  }

  const currentRoom = rooms[index];

  // 与后端一致的状态机校验：非法流转（含重复点击导致的倒退）一律拒绝
  if (!canTransition(currentRoom.status, status)) {
    const error = new Error(getRejectedMessage(currentRoom.status, status));
    (error as Error & { status: number }).status = 409;
    throw error;
  }

  // 幂等：目标状态与当前相同，直接返回当前房间
  if (currentRoom.status === status) {
    return { ...currentRoom };
  }

  const now = new Date().toISOString();
  const updatedRoom: InterviewRoom = {
    ...currentRoom,
    status: status as InterviewRoom['status'],
    startedAt: status === 'ACTIVE' ? (currentRoom.startedAt || now) : currentRoom.startedAt,
    endedAt: (status === 'COMPLETED' || status === 'CANCELLED')
      ? (currentRoom.endedAt || now)
      : status === 'ACTIVE' ? undefined : currentRoom.endedAt,
  };

  roomsCache = [...rooms];
  roomsCache[index] = updatedRoom;
  saveToStorage(roomsCache);
  return { ...updatedRoom };
}

export async function mockGetRoomParticipants(roomId: string): Promise<ParticipantStatus[]> {
  await delay(200);
  const rooms = getRoomsCache();
  const room = rooms.find(r => r.id === roomId);
  if (!room) {
    throw new Error('房间不存在');
  }

  const participants: ParticipantStatus[] = [];
  if (room.interviewerId) {
    participants.push({
      id: 'participant-interviewer-' + room.interviewerId,
      roomId: roomId,
      userId: room.interviewerId,
      userName: '面试官',
      userRole: 'INTERVIEWER',
      isOnline: true,
      lastHeartbeat: new Date().toISOString(),
      joinedAt: room.createdAt,
    });
  }
  if (room.candidateId) {
    participants.push({
      id: 'participant-candidate-' + room.candidateId,
      roomId: roomId,
      userId: room.candidateId,
      userName: '候选人',
      userRole: 'CANDIDATE',
      isOnline: true,
      lastHeartbeat: new Date().toISOString(),
      joinedAt: room.startedAt || room.createdAt,
    });
  }

  return participants;
}

export async function mockJoinRoom(roomId: string, data: { candidateName: string; inviteToken: string }): Promise<JoinRoomResponse> {
  await delay(500);
  const rooms = getRoomsCache();
  const index = rooms.findIndex(r => r.id === roomId);
  if (index === -1) {
    throw new Error('房间不存在');
  }

  const candidateId = 'candidate-' + Date.now();
  const now = new Date().toISOString();

  // 候选人加入不改变房间状态：是否开始由面试官在就绪检查通过后决定
  const updatedRoom: InterviewRoom = {
    ...rooms[index],
    candidateId,
  };

  const participant: ParticipantStatus = {
    id: 'participant-' + Date.now(),
    roomId: roomId,
    userId: candidateId,
    userName: data.candidateName,
    userRole: 'CANDIDATE',
    isOnline: true,
    lastHeartbeat: now,
    joinedAt: now,
  };

  roomsCache = [...rooms];
  roomsCache[index] = updatedRoom;
  saveToStorage(roomsCache);

  return {
    participant: { ...participant },
    room: { ...updatedRoom },
    message: '加入成功',
  };
}

export async function mockLeaveRoom(_roomId: string, _userId: string): Promise<void> {
  await delay(200);
}

export async function mockHeartbeat(roomId: string, userId: string): Promise<ParticipantStatus> {
  await delay(100);
  return {
    id: 'participant-' + userId,
    roomId: roomId,
    userId: userId,
    userName: '用户',
    userRole: 'INTERVIEWER',
    isOnline: true,
    lastHeartbeat: new Date().toISOString(),
    joinedAt: new Date().toISOString(),
  };
}

export const resetMockRoomData = () => {
  roomsCache = [...mockRooms];
  saveToStorage(roomsCache);
};
