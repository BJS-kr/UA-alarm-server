import { Db } from './database';

/** 트랜잭션 안팎에서 같은 함수를 쓰기 위한 타입. db와 tx 모두 execute를 가진다. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type Executor = Pick<Db, 'execute'> | Pick<Tx, 'execute'>;
