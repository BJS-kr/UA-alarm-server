import { Db } from './database';

/** 트랜잭션 안팎에서 같은 저장소 함수를 쓰기 위한 타입. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Db | Tx;
