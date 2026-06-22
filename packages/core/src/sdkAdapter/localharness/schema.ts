// localharness protobuf 스키마 — protobufjs JSON namespace를 Root.fromJSON으로 로드(코어 API).
// 부트스트랩 2개 메시지(InputConfig 인코드 / OutputConfig 디코드)의 binary 직렬화에만 쓴다.
// WS 메시지는 전부 proto3 JSON(camelCase)이라 plain object로 직접 주고받음(여기 안 거침).
import protobuf from 'protobufjs';
import { LOCALHARNESS_SCHEMA } from './schema-json.js';

const root = protobuf.Root.fromJSON(LOCALHARNESS_SCHEMA as unknown as protobuf.INamespace);

const PKG = 'antigravity.localharness.';
export const InputConfig = root.lookupType(PKG + 'InputConfig');
export const OutputConfig = root.lookupType(PKG + 'OutputConfig');
