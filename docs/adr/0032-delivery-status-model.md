# ADR-0032. Delivery 상태는 여섯 개이고, 끝 상태는 SENT, FAILED, CANCELED다

## 배경

Delivery는 수신자 한 명에게 보내는 일 하나다. 이 일은 기다리고, 보내지고, 실패해 다시 기다리고, 결과를 몰라 조회를 기다리는 등 여러 단계를 거친다. 상태를 어떻게 나누느냐가 "끝나지 않은 건이 남았는가"와 "누가 실제로 받았는가"를 정확히 답하는 바탕이 된다.

## 결정

| 상태 | 뜻 |
| --- | --- |
| PENDING | 꺼낼 수 있거나, 재시도 시각을 기다린다 |
| IN_FLIGHT | 워커가 쥐고(담당, 기한) 외부로 보내는 중이다 |
| UNCONFIRMED | 보냈는지 모른다. 조회 시각이 되면 조회한다 |
| SENT | 202를 받았거나, 조회로 기록을 확인했다 |
| FAILED | 400을 받았거나, 시도를 모두 썼다 |
| CANCELED | 알림이 취소되어 보내지 않았다 |

## 전이

| 지금 | 일 | 다음 |
| --- | --- | --- |
| PENDING | 워커가 꺼냄 | IN_FLIGHT |
| PENDING | 알림 취소 정리(ADR-0017) | CANCELED |
| IN_FLIGHT | 202 | SENT |
| IN_FLIGHT | 400, 또는 시도를 다 씀 | FAILED |
| IN_FLIGHT | 500·503·연결 거부(재시도 시각을 두고), 429, 브레이커가 열린 동안의 5xx·연결 오류(ADR-0014), 보내지 않은 건 반납(정상 종료, 발송 직전 확인) | PENDING |
| IN_FLIGHT | 타임아웃, 보낸 뒤 끊김, 502·504, 기한이 지나 넘겨받음(ADR-0004) | UNCONFIRMED |
| UNCONFIRMED | 조회: 기록 있음 | SENT |
| UNCONFIRMED | 조회: 기록 없음, 시도 남음 | PENDING |
| UNCONFIRMED | 조회: 기록 없음, 시도 다 씀 | FAILED |
| UNCONFIRMED | 조회: 기록 없음, 알림이 취소 중 | CANCELED |
| UNCONFIRMED | 조회 실패 | 그대로. 간격을 늘려 다시 조회한다 |

PENDING으로 가는 모든 전이는, 알림이 SENDING이 아니면 PENDING 대신 CANCELED로 간다(ADR-0017).

## 규칙

- **끝 상태는 SENT, FAILED, CANCELED다.** 한 번 들어가면 나오지 않는다. 완료 판정이 보는 "끝나지 않은 건"은 PENDING, IN_FLIGHT, UNCONFIRMED다(ADR-0018).
- **조회에서 기록이 없으면 바로 보내지 않고 PENDING으로 되돌린다.** 다시 보낼 때도 토큰을 받아야 하고(ADR-0009) 우선순위 순서를 지켜야 하므로(ADR-0011), 같은 꺼내기 경로를 탄다.
- **조회도 꺼내기처럼 쥐고(30초 기한) 한다.** 조회는 읽기만 하므로 겹쳐도 해롭지 않다. 결과 반영은 `WHERE status = 'UNCONFIRMED'` 조건으로 한 번만 일어난다.
- **모든 전이는 조건부 UPDATE다**(ADR-0016). IN_FLIGHT에서 나가는 전이는 담당과 시도 번호 조건을 함께 건다(ADR-0004).

## 이름: SENDING이 아니라 IN_FLIGHT

알림 상태에 이미 SENDING(발송이 진행 중인 알림)이 있다. Delivery의 "보내는 중" 상태도 SENDING이라 부르면, 같은 이름이 두 테이블과 로그에서 다른 뜻으로 섞인다. CANCELED는 두 곳에서 같은 뜻이라 그대로 쓴다.
