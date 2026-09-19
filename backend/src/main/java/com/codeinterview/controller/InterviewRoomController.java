package com.codeinterview.controller;

import com.codeinterview.dto.CreateRoomResponse;
import com.codeinterview.dto.JoinRoomResponse;
import com.codeinterview.dto.WebSocketMessage;
import com.codeinterview.model.CandidateInvitation;
import com.codeinterview.model.InterviewRoom;
import com.codeinterview.model.ParticipantStatus;
import com.codeinterview.repository.CandidateInvitationRepository;
import com.codeinterview.repository.InterviewRoomRepository;
import com.codeinterview.repository.ParticipantStatusRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Random;

@RestController
@RequestMapping("/api/interview-rooms")
@CrossOrigin(origins = "*")
public class InterviewRoomController {

    @Autowired
    private InterviewRoomRepository interviewRoomRepository;

    @Autowired
    private CandidateInvitationRepository candidateInvitationRepository;

    @Autowired
    private ParticipantStatusRepository participantStatusRepository;

    @Autowired
    private SimpMessagingTemplate messagingTemplate;

    private static final String ROOM_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    private static final int ROOM_CODE_LENGTH = 6;

    @PostMapping
    @Transactional
    public ResponseEntity<CreateRoomResponse> createInterviewRoom(@RequestBody Map<String, String> request) {
        String title = request.get("title");
        String problemId = request.get("problemId");
        String interviewerId = request.get("interviewerId");
        String interviewerName = request.get("interviewerName");

        InterviewRoom room = new InterviewRoom();
        room.setTitle(title);
        room.setProblemId(problemId);
        room.setInterviewerId(interviewerId);
        room.setStatus("WAITING");
        room.setRoomCode(generateUniqueRoomCode());
        room.setCreatedAt(LocalDateTime.now());

        InterviewRoom savedRoom = interviewRoomRepository.save(room);

        ParticipantStatus interviewerStatus = new ParticipantStatus();
        interviewerStatus.setRoomId(savedRoom.getId());
        interviewerStatus.setUserId(interviewerId);
        interviewerStatus.setUserName(interviewerName);
        interviewerStatus.setUserRole("INTERVIEWER");
        interviewerStatus.setOnline(true);
        interviewerStatus.setLastHeartbeat(LocalDateTime.now());
        interviewerStatus.setJoinedAt(LocalDateTime.now());
        ParticipantStatus savedInterviewerStatus = participantStatusRepository.save(interviewerStatus);

        return new ResponseEntity<>(new CreateRoomResponse(savedRoom, savedInterviewerStatus), HttpStatus.CREATED);
    }

    @GetMapping("/{roomId}")
    public ResponseEntity<InterviewRoom> getInterviewRoomById(@PathVariable String roomId) {
        Optional<InterviewRoom> room = interviewRoomRepository.findById(roomId);
        return room.map(ResponseEntity::ok)
                .orElseGet(() -> new ResponseEntity<>(HttpStatus.NOT_FOUND));
    }

    @GetMapping("/code/{roomCode}")
    public ResponseEntity<InterviewRoom> getInterviewRoomByCode(@PathVariable String roomCode) {
        Optional<InterviewRoom> room = interviewRoomRepository.findByRoomCode(roomCode);
        return room.map(ResponseEntity::ok)
                .orElseGet(() -> new ResponseEntity<>(HttpStatus.NOT_FOUND));
    }

    @GetMapping("/interviewer/{interviewerId}")
    public ResponseEntity<List<InterviewRoom>> getInterviewRoomsByInterviewer(@PathVariable String interviewerId) {
        List<InterviewRoom> rooms = interviewRoomRepository.findByInterviewerIdOrderByCreatedAtDesc(interviewerId);
        return new ResponseEntity<>(rooms, HttpStatus.OK);
    }

    @PutMapping("/{roomId}/status")
    @Transactional
    public ResponseEntity<InterviewRoom> updateRoomStatus(@PathVariable String roomId, @RequestBody Map<String, String> request) {
        String status = request.get("status");
        Optional<InterviewRoom> roomOpt = interviewRoomRepository.findById(roomId);

        if (roomOpt.isEmpty()) {
            return new ResponseEntity<>(HttpStatus.NOT_FOUND);
        }

        if (!isValidStatus(status)) {
            return new ResponseEntity("未知的房间状态：" + status, HttpStatus.BAD_REQUEST);
        }

        InterviewRoom room = roomOpt.get();
        String currentStatus = room.getStatus();

        // 幂等：重复点击相同的开始/结束操作时直接返回当前房间，状态不倒退
        if (currentStatus.equals(status)) {
            return new ResponseEntity<>(room, HttpStatus.OK);
        }

        if (!isTransitionAllowed(currentStatus, status)) {
            return new ResponseEntity(getRejectedMessage(currentStatus, status), HttpStatus.CONFLICT);
        }

        // WAITING -> ACTIVE 的开始前确认：题目已配置且候选人已在线，否则保持等待并指出缺项
        if ("WAITING".equals(currentStatus) && "ACTIVE".equals(status)) {
            List<String> missing = new java.util.ArrayList<>();
            if (room.getProblemId() == null || room.getProblemId().trim().isEmpty()) {
                missing.add("题目未配置");
            }
            boolean candidateOnline = participantStatusRepository.findByRoomId(roomId).stream()
                    .anyMatch(p -> "CANDIDATE".equals(p.getUserRole()) && p.isOnline());
            if (!candidateOnline) {
                missing.add("候选人尚未进入房间");
            }
            if (!missing.isEmpty()) {
                return new ResponseEntity("面试尚未就绪：" + String.join("、", missing), HttpStatus.CONFLICT);
            }
        }

        room.setStatus(status);

        if ("ACTIVE".equals(status)) {
            if (room.getStartedAt() == null) {
                room.setStartedAt(LocalDateTime.now());
            }
            // 从已结束恢复进行中：清除结束时间，面试计时继续，代码与记录均保留
            room.setEndedAt(null);
        } else if ("COMPLETED".equals(status) || "CANCELLED".equals(status)) {
            if (room.getEndedAt() == null) {
                room.setEndedAt(LocalDateTime.now());
            }
        }

        InterviewRoom updatedRoom = interviewRoomRepository.save(room);

        // 广播房间状态，候选人端及其他标签页可即时感知开始/结束/恢复
        messagingTemplate.convertAndSend("/topic/room/" + roomId + "/status",
                new WebSocketMessage<>("ROOM_STATUS", updatedRoom));

        return new ResponseEntity<>(updatedRoom, HttpStatus.OK);
    }

    private boolean isValidStatus(String status) {
        return "WAITING".equals(status) || "ACTIVE".equals(status)
                || "COMPLETED".equals(status) || "CANCELLED".equals(status);
    }

    /**
     * 房间状态机：
     * WAITING   -> ACTIVE / CANCELLED
     * ACTIVE    -> COMPLETED
     * COMPLETED -> ACTIVE（误结束后恢复）
     * CANCELLED 为终态
     */
    private boolean isTransitionAllowed(String from, String to) {
        if ("WAITING".equals(from)) {
            return "ACTIVE".equals(to) || "CANCELLED".equals(to);
        }
        if ("ACTIVE".equals(from)) {
            return "COMPLETED".equals(to);
        }
        if ("COMPLETED".equals(from)) {
            return "ACTIVE".equals(to);
        }
        return false;
    }

    private String getRejectedMessage(String from, String to) {
        if ("COMPLETED".equals(from) && "ACTIVE".equals(to)) {
            return "面试已结束，无法重新开始，如需继续请使用恢复操作";
        }
        if ("WAITING".equals(from) && "COMPLETED".equals(to)) {
            return "面试尚未开始，无法结束";
        }
        return "当前状态不允许该操作（" + from + " -> " + to + "）";
    }

    @GetMapping("/{roomId}/participants")
    public ResponseEntity<List<ParticipantStatus>> getRoomParticipants(@PathVariable String roomId) {
        List<ParticipantStatus> participants = participantStatusRepository.findByRoomId(roomId);
        return new ResponseEntity<>(participants, HttpStatus.OK);
    }

    @PostMapping("/{roomId}/join")
    @Transactional
    public ResponseEntity<JoinRoomResponse> joinRoom(@PathVariable String roomId, @RequestBody Map<String, String> request) {
        String candidateName = request.get("candidateName");
        String inviteToken = request.get("inviteToken");

        Optional<InterviewRoom> roomOpt = interviewRoomRepository.findById(roomId);
        if (roomOpt.isEmpty()) {
            return new ResponseEntity<>(HttpStatus.NOT_FOUND);
        }
        InterviewRoom room = roomOpt.get();

        String message = "Joined via room code";

        if (inviteToken != null && !inviteToken.trim().isEmpty()) {
            Optional<CandidateInvitation> invitationOpt = candidateInvitationRepository.findByInviteToken(inviteToken);
            if (invitationOpt.isEmpty()) {
                return new ResponseEntity<>(HttpStatus.UNAUTHORIZED);
            }

            CandidateInvitation invitation = invitationOpt.get();
            if (!invitation.getRoomId().equals(roomId)) {
                return new ResponseEntity<>(HttpStatus.BAD_REQUEST);
            }

            invitation.setStatus("JOINED");
            invitation.setJoinedAt(LocalDateTime.now());
            candidateInvitationRepository.save(invitation);
            message = "Joined via invitation token";
        }

        ParticipantStatus candidateStatus = new ParticipantStatus();
        candidateStatus.setRoomId(roomId);
        candidateStatus.setUserName(candidateName);
        candidateStatus.setUserRole("CANDIDATE");
        candidateStatus.setOnline(true);
        candidateStatus.setLastHeartbeat(LocalDateTime.now());
        candidateStatus.setJoinedAt(LocalDateTime.now());
        ParticipantStatus savedStatus = participantStatusRepository.save(candidateStatus);

        savedStatus.setUserId(savedStatus.getId());
        participantStatusRepository.save(savedStatus);

        List<ParticipantStatus> participants = participantStatusRepository.findByRoomId(roomId);
        messagingTemplate.convertAndSend("/topic/room/" + roomId + "/participants",
                new WebSocketMessage<>("PARTICIPANTS_UPDATE", participants));

        JoinRoomResponse response = new JoinRoomResponse(savedStatus, room, message);
        return new ResponseEntity<>(response, HttpStatus.OK);
    }

    @PostMapping("/{roomId}/leave")
    @Transactional
    public ResponseEntity<Void> leaveRoom(@PathVariable String roomId, @RequestBody Map<String, String> request) {
        String userId = request.get("userId");

        Optional<ParticipantStatus> statusOpt = participantStatusRepository.findByRoomIdAndUserId(roomId, userId);
        if (statusOpt.isEmpty()) {
            return new ResponseEntity<>(HttpStatus.NOT_FOUND);
        }

        ParticipantStatus status = statusOpt.get();
        status.setOnline(false);
        participantStatusRepository.save(status);

        List<ParticipantStatus> participants = participantStatusRepository.findByRoomId(roomId);
        messagingTemplate.convertAndSend("/topic/room/" + roomId + "/participants",
                new WebSocketMessage<>("PARTICIPANTS_UPDATE", participants));

        return new ResponseEntity<>(HttpStatus.OK);
    }

    @PostMapping("/{roomId}/heartbeat")
    @Transactional
    public ResponseEntity<ParticipantStatus> heartbeat(@PathVariable String roomId, @RequestBody Map<String, String> request) {
        String userId = request.get("userId");

        Optional<ParticipantStatus> statusOpt = participantStatusRepository.findByRoomIdAndUserId(roomId, userId);
        if (statusOpt.isEmpty()) {
            return new ResponseEntity<>(HttpStatus.NOT_FOUND);
        }

        ParticipantStatus status = statusOpt.get();
        status.setOnline(true);
        status.setLastHeartbeat(LocalDateTime.now());
        ParticipantStatus updatedStatus = participantStatusRepository.save(status);

        List<ParticipantStatus> participants = participantStatusRepository.findByRoomId(roomId);
        messagingTemplate.convertAndSend("/topic/room/" + roomId + "/participants",
                new WebSocketMessage<>("PARTICIPANTS_UPDATE", participants));

        return new ResponseEntity<>(updatedStatus, HttpStatus.OK);
    }

    private String generateUniqueRoomCode() {
        Random random = new Random();
        String code;
        do {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < ROOM_CODE_LENGTH; i++) {
                sb.append(ROOM_CODE_CHARS.charAt(random.nextInt(ROOM_CODE_CHARS.length())));
            }
            code = sb.toString();
        } while (interviewRoomRepository.existsByRoomCode(code));
        return code;
    }
}
