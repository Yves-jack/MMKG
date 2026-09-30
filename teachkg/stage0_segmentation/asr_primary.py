"""
阶段 B：Qwen3-ASR-Flash 主转写（按 VAD 语音段 + context 偏置）。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from teachkg.schemas import SubtitleCue
from teachkg.stage0_segmentation.audio_preprocess import AudioPreprocessor, SpeechSegment
from teachkg.stage0_segmentation.qwen3_asr import Qwen3ASRClient

logger = logging.getLogger(__name__)

_CUE_FIELDS = frozenset({"start_sec", "end_sec", "text"})


def _is_rate_limit_error(exc: BaseException) -> bool:
    """判断异常是否为限流（HTTP 429 / 文案含 rate limit 等）"""
    text = str(exc).lower()
    if "429" in text or "rate limit" in text or "too many requests" in text:
        return True
    code = getattr(exc, "status_code", None) or getattr(exc, "code", None)
    return code == 429


class PrimaryASR:
    """按 VAD 段调用云端 ASR，产出 ``SubtitleCue`` 列表。"""

    def __init__(
        self,
        client: Qwen3ASRClient,
        preprocessor: AudioPreprocessor, # 用于按段切音频文件
        base_context: str = "", # 全局术语/课程偏置，与 ``extra_context`` 拼接后送 ASR
        *,
        max_retry: int = 5, # 单段最大尝试次数（含首次）
        retry_pause_sec: float = 5.0, # 首次退避基数（秒），之后指数增长
        max_retry_pause_sec: float = 60.0, # 单次退避上限（秒）
        retry_jitter: bool = True, # 是否对退避乘 0.5~1.5 随机抖动
        remove_checkpoint_on_success: bool = True, # 整讲成功后是否删除 checkpoint
        max_workers: int = 4, # 并行 ASR 线程数（建议先 4，观察 429 再调）
    ) -> None:
        self.client = client
        self.preprocessor = preprocessor
        self.base_context = base_context
        self.max_retry = max(1, int(max_retry))
        self.retry_pause_sec = float(retry_pause_sec)
        self.max_retry_pause_sec = float(max_retry_pause_sec)
        self.retry_jitter = retry_jitter
        self.remove_checkpoint_on_success = remove_checkpoint_on_success
        self.max_workers = max(1, int(max_workers))
        self._ckpt_lock = threading.Lock()

    @staticmethod
    def _hash_text(text: str) -> str:
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

    @staticmethod
    def _segments_fingerprint(segments: list[SpeechSegment]) -> str:
        payload = "|".join(f"{s.start_sec:.3f}-{s.end_sec:.3f}" for s in segments)
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]

    @staticmethod
    def _wav_identity(wav_path: Path) -> dict[str, Any]:
        resolved = wav_path.resolve()
        st = resolved.stat()
        return {
            "wav_path": str(resolved),
            "wav_mtime_ns": int(st.st_mtime_ns),
            "wav_size": int(st.st_size),
        }

    @classmethod
    def _checkpoint_meta(
        cls,
        wav_path: Path,
        segments: list[SpeechSegment],
        context: str,
        *,
        asr_model: str = "",
        asr_language: str = "",
        asr_enable_itn: bool = True,
    ) -> dict[str, Any]:
        return {
            **cls._wav_identity(wav_path),
            "segment_count": len(segments),
            "segments_fp": cls._segments_fingerprint(segments),
            "context_hash": cls._hash_text(context),
            "audio_span_sec": float(segments[-1].end_sec) if segments else 0.0,
            "asr_model": asr_model,
            "asr_language": asr_language,
            "asr_enable_itn": bool(asr_enable_itn),
        }

    @classmethod
    def _meta_matches(cls, saved: dict[str, Any] | None, expected: dict[str, Any]) -> bool:
        if not isinstance(saved, dict):
            return False
        for key, value in expected.items():
            if saved.get(key) != value:
                return False
        return True

    def _save_checkpoint(self, path: Path, done: dict[int, dict[str, Any] | None], meta: dict[str, Any]) -> None:
        """done: index -> cue dict；空转写记为 null。"""

        path.parent.mkdir(parents=True, exist_ok=True) # 创建父目录
        # 兼容旧字段：next_index = 连续前缀完成长度（供旧工具读取）
        next_index = 0 # 连续前缀完成长度
        while next_index in done: # 如果 next_index 在 done 中
            next_index += 1 # 连续前缀完成长度加1
        payload = { # 生成 payload  
            "meta": meta,
            "done": {str(k): v for k, v in sorted(done.items())},
            "next_index": next_index,
            "cues": [v for _, v in sorted(done.items()) if isinstance(v, dict) and (v.get("text") or "").strip()],
        }
        tmp = path.with_suffix(path.suffix + ".tmp") # 临时文件路径
        with self._ckpt_lock:
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8") # 写入临时文件
            os.replace(tmp, path) # 替换原文件

    @staticmethod
    def _cue_from_dict(raw: dict[str, Any]) -> SubtitleCue:
        return SubtitleCue(**{k: raw[k] for k in _CUE_FIELDS if k in raw})

    def _load_checkpoint( self, path: Path, expected_meta: dict[str, Any],segments: list[SpeechSegment]) -> dict[int, dict[str, Any] | None] | None:
        """校验 meta；返回已完成 index→结果；不一致返回 None。"""

        # 尝试加载 checkpoint
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning(f"Primary ASR checkpoint unreadable ({path}): {exc}")
            return None

        if not self._meta_matches(data.get("meta"), expected_meta): # 检查 meta 是否一致
            logger.warning(f"Primary ASR checkpoint meta mismatch → discard resume ({path}). saved={data.get('meta')} expected={expected_meta}")
            return None

        n = int(expected_meta["segment_count"])
        done: dict[int, dict[str, Any] | None] = {}

        raw_done = data.get("done") # 获取已完成 index→结果
        if isinstance(raw_done, dict):
            for k, v in raw_done.items():
                try:
                    idx = int(k)
                except (TypeError, ValueError):
                    continue
                if idx < 0 or idx >= n:
                    continue
                if v is None:
                    done[idx] = None
                elif isinstance(v, dict):
                    done[idx] = {
                        "start_sec": float(v.get("start_sec", segments[idx].start_sec)),
                        "end_sec": float(v.get("end_sec", segments[idx].end_sec)),
                        "text": str(v.get("text", "")),
                    }
            return done

        # 0到next_index-1 视为已完成
        next_index = int(data.get("next_index", 0))
        if next_index < 0 or next_index > n:
            logger.warning(f"Primary ASR checkpoint next_index={next_index} out of range [0, {n}] → discard")
            return None
        
        # 判断 cues 中的 cue 是否与 segments 中的 seg 时间戳接近，如果接近则认为该段结果，否则记空跳过
        cues = [self._cue_from_dict(c) for c in data.get("cues", []) if isinstance(c, dict)] # 获取 cues
        cue_i = 0
        for idx in range(next_index):
            seg = segments[idx]
            if cue_i < len(cues):
                c = cues[cue_i]
                # 时间戳接近则认作该段结果，否则记空跳过
                if abs(c.start_sec - seg.start_sec) < 0.05 and abs(c.end_sec - seg.end_sec) < 0.05:
                    done[idx] = {
                        "start_sec": c.start_sec,
                        "end_sec": c.end_sec,
                        "text": c.text,
                    }
                    cue_i += 1
                    continue
            done[idx] = None
        return done

    def _sleep_before_retry(self, attempt: int) -> None:
        delay = min(self.retry_pause_sec * (2 ** (attempt - 1)), self.max_retry_pause_sec) # 计算休眠时间
        if self.retry_jitter: # 如果需要抖动
            delay *= 0.5 + random.random() # 抖动
        time.sleep(delay) # 休眠

    def _transcribe_one(self, idx: int, seg: SpeechSegment, wav_path: Path, work_dir: Path, context: str, total: int) -> tuple[int, str, int, int, float]:
        """转写单个 VAD 段（线程内调用）。"""

        # 处理单个 VAD 段
        chunk_path = work_dir / f"vad_{idx + 1:04d}.wav" # 切段后的音频文件路径
        self.preprocessor.cut_segment(wav_path, seg, chunk_path) # 切段
        text = "" # 转写结果
        retries = 0 # 重试次数
        rate_hits = 0 # 限流次数
        last_exc: Exception | None = None # 最后一次异常
        t0 = time.perf_counter() # 开始时间
        try:
            for attempt in range(1, self.max_retry + 1): # 尝试转写
                try:
                    text = self.client.transcribe_audio(chunk_path, context=context)
                    last_exc = None
                    break
                except Exception as exc:  # noqa: BLE001
                    last_exc = exc
                    if _is_rate_limit_error(exc): # 判断是否为限流异常
                        rate_hits += 1
                    if attempt < self.max_retry: # 如果重试次数小于最大重试次数
                        retries += 1
                    final_attempt = attempt >= self.max_retry
                    logger.warning(f"Primary ASR {idx + 1}/{total} attempt {attempt}/{self.max_retry} failed: {exc}")
                    if not final_attempt:
                        self._sleep_before_retry(attempt) # 休眠
            if last_exc is not None:
                raise last_exc
            return idx, text.strip(), retries, rate_hits, time.perf_counter() - t0
        finally:
            chunk_path.unlink(missing_ok=True) # 删除切段后的音频文件

    def transcribe_vad_segments(
        self,
        wav_path: Path, # 整讲预处理后的音频文件路径
        segments: list[SpeechSegment], # VAD 语音段列表（起止秒）
        work_dir: Path, # 临时切段目录（写入 ``vad_XXXX.wav``，用完删除）
        extra_context: str = "", # 本讲额外偏置，与 ``base_context`` 用换行拼接
        checkpoint_path: Path | None = None, # 可选 checkpoint JSON；meta 不一致则丢弃重跑
    ) -> list[SubtitleCue]:
        """按 VAD 语音段并行转写，支持 checkpoint 断点续跑。"""

        # 处理前准备
        wav_path = Path(wav_path)
        work_dir = Path(work_dir)
        work_dir.mkdir(parents=True, exist_ok=True)

        context = "\n".join(p for p in [self.base_context, extra_context] if p.strip())
        meta = self._checkpoint_meta( # 生成 checkpoint 元数据
            wav_path,
            segments, # VAD 语音段列表
            context, # ASR context 偏置
            asr_model=getattr(self.client, "model_name", ""), # ASR 模型名称
            asr_language=getattr(self.client, "language", ""), # ASR 语言
            asr_enable_itn=bool(getattr(self.client, "enable_itn", True)), # ASR 是否启用 ITN
        )

        # 加载 checkpoint
        done: dict[int, dict[str, Any] | None] = {} # 已完成 index→结果；空转写记为 null。
        if checkpoint_path and checkpoint_path.exists():
            loaded = self._load_checkpoint(checkpoint_path, meta, segments) # 加载 checkpoint
            if loaded is None:
                checkpoint_path.unlink(missing_ok=True) # 删除 checkpoint
            else:
                done = loaded # 更新已完成 index→结果
                logger.info(f"Resume primary ASR: {len(done)}/{len(segments)} segments already done (workers={self.max_workers})") # 恢复 ASR

        # 获取未完成 index 列表
        pending = [i for i in range(len(segments)) if i not in done]
        ok_count = 0 # 成功转写段数
        skip_count = 0 # 空转写段数
        for v in done.values(): # 遍历已完成 index→结果
            if isinstance(v, dict) and (v.get("text") or "").strip(): # 如果结果不为空
                ok_count += 1 # 成功转写段数加1
            else:
                skip_count += 1 # 空转写段数加1

        retry_count = 0
        rate_limit_hits = 0
        t_all = time.perf_counter() # 开始时间
        workers = min(self.max_workers, max(1, len(pending))) if pending else 1 # 并行线程数

        logger.info(f"Primary ASR start: pending={len(pending)}/{len(segments)} workers={workers if pending else 0}")

        if pending: # 如果未完成段数大于0
            with ThreadPoolExecutor(max_workers=workers) as pool: # 创建线程池
                futures = {
                    pool.submit(self._transcribe_one, idx, segments[idx], wav_path, work_dir, context, len(segments)): idx for idx in pending
                }
                finished = 0 # 已完成段数
                try:
                    for fut in as_completed(futures): # 遍历已完成任务
                        idx = futures[fut] # 获取任务索引
                        seg = segments[idx] # 获取语音段
                        try:
                            _i, cleaned, retries, rate_hits, seg_elapsed = fut.result()
                        except Exception as exc:
                            if checkpoint_path: # 如果 checkpoint 路径存在
                                self._save_checkpoint(checkpoint_path, done, meta) # 保存 checkpoint
                            logger.error(f"Primary ASR aborted at {idx + 1}/{len(segments)} after {time.perf_counter() - t_all}s (ok={ok_count} skip={skip_count} retries={retry_count} rate_limit_hits={rate_limit_hits})")
                            # 取消其余任务
                            for other in futures: # 遍历未完成任务
                                other.cancel()
                            raise exc

                        retry_count += retries # 重试次数加1
                        rate_limit_hits += rate_hits
                        finished += 1

                        if cleaned:
                            done[idx] = {
                                "start_sec": seg.start_sec,
                                "end_sec": seg.end_sec,
                                "text": cleaned,
                            }
                            ok_count += 1
                            logger.info(f"Primary ASR {idx + 1}/{len(segments)} [{seg.start_sec}-{seg.end_sec}s]: {len(cleaned)} chars (seg_elapsed={seg_elapsed}s)")
                        else:
                            done[idx] = None
                            skip_count += 1
                            logger.debug(f"Primary ASR {idx + 1}/{len(segments)} [{seg.start_sec}-{seg.end_sec}s]: empty text, skipped (seg_elapsed={seg_elapsed}s)")

                        if checkpoint_path and (
                            finished % max(1, workers) == 0 or finished == len(pending) # 如果已完成段数能被并行线程数整除或者等于未完成段数
                        ):
                            self._save_checkpoint(checkpoint_path, done, meta)
                except Exception:
                    raise

        cues = [
            self._cue_from_dict(done[i])  # type: ignore[arg-type]
            for i in range(len(segments))
            if isinstance(done.get(i), dict) and (done[i] or {}).get("text", "").strip()  # type: ignore[union-attr]
        ]

        total_elapsed = time.perf_counter() - t_all
        attempted = len(pending)
        rate_pct = (100.0 * rate_limit_hits / max(attempted, 1)) if attempted else 0.0
        logger.info(
            f"Primary ASR done: {attempted}/{len(segments)} segments in {total_elapsed}s "
            f"(ok={ok_count} skip={skip_count} retries={retry_count} rate_limit_hits={rate_limit_hits} ({rate_pct}% of pending), "
            f"workers={workers if pending else self.max_workers}, resumed_done={len(segments) - attempted})"
        )

        if self.remove_checkpoint_on_success and checkpoint_path and checkpoint_path.exists():
            checkpoint_path.unlink(missing_ok=True) # 删除 checkpoint

        return cues # 返回转写结果
