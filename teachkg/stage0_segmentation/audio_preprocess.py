"""
阶段 A：音频预处理 + Silero VAD 语音活动检测。
"""

from __future__ import annotations

import logging
import os
import subprocess
import wave
import shutil
import time
import numpy as np
import torch
from dataclasses import dataclass
from pathlib import Path
from functools import lru_cache

logger = logging.getLogger(__name__)

_THREAD_TUNING_APPLIED = False


def _apply_vad_thread_tuning(torch_num_threads: int | None = None, onnx_intra_op_num_threads: int | None = None) -> None:
    """可选：多进程并发时限制线程，避免 CPU 过订阅。默认不启用（参数均为 None）。"""

    global _THREAD_TUNING_APPLIED
    if _THREAD_TUNING_APPLIED:
        return
    if torch_num_threads is None and onnx_intra_op_num_threads is None: # 如果线程数为 None，则不启用线程限制
        return

    if torch_num_threads is not None and torch_num_threads > 0: # 如果线程数大于 0，则设置线程数
        torch.set_num_threads(int(torch_num_threads))
        logger.info(f"VAD torch.set_num_threads({torch_num_threads})")

    if onnx_intra_op_num_threads is not None and onnx_intra_op_num_threads > 0: # 如果线程数大于 0，则设置线程数
        # 须在首次创建 ORT Session（load_silero_vad）之前设置
        os.environ["ORT_INTRA_OP_NUM_THREADS"] = str(int(onnx_intra_op_num_threads))
        logger.info(f"VAD ORT_INTRA_OP_NUM_THREADS={onnx_intra_op_num_threads} (设置在 Silero ONNX 加载之前)")

    _THREAD_TUNING_APPLIED = True # 设置线程限制已应用


@lru_cache(maxsize=1)
def _load_vad_model():
    """优先 ONNX；缺 onnxruntime 或加载失败时回退 Torch 权重。"""

    from silero_vad import load_silero_vad

    try:
        model = load_silero_vad(onnx=True)
        logger.info("Silero VAD loaded (onnx=True)")
        return model
    except Exception as exc:
        logger.warning(f"Silero VAD ONNX load failed ({exc}); falling back to onnx=False")
        model = load_silero_vad(onnx=False)
        logger.info("Silero VAD loaded (onnx=False)")
        return model


@dataclass
class SpeechSegment:
    start_sec: float
    end_sec: float

    @property
    def duration_sec(self) -> float:
        return self.end_sec - self.start_sec


class AudioPreprocessor:
    def __init__(
        self,
        sample_rate: int = 16000,
        denoise: bool = True,
        loudnorm: bool = True,
        vad_threshold: float = 0.5,
        min_speech_sec: float = 0.3,
        min_silence_sec: float = 0.4,
        max_segment_sec: float = 120.0,
        *,
        vad_split_overlap_sec: float = 0.5,
        torch_num_threads: int | None = None,
        onnx_intra_op_num_threads: int | None = None,
    ) -> None:
        self.sample_rate = sample_rate
        self.denoise = denoise
        self.loudnorm = loudnorm
        self.vad_threshold = vad_threshold
        self.min_speech_sec = min_speech_sec
        self.min_silence_sec = min_silence_sec
        self.max_segment_sec = max_segment_sec
        self.vad_split_overlap_sec = max(0.0, float(vad_split_overlap_sec))
        # 多课程并行时再设；默认 None 表示不改动全局线程数
        self.torch_num_threads = torch_num_threads
        self.onnx_intra_op_num_threads = onnx_intra_op_num_threads

    def extract_from_video(self, video_path: Path, output_wav: Path) -> Path:
        """从视频提取音频，输出单声道 PCM WAV。"""

        # 处理前检查(视频文件是否存在、输出文件是否为wav、采样率是否合法、ffmpeg是否安装)
        if not video_path.is_file():
            raise FileNotFoundError(f"输入视频不存在: {video_path}")
        if output_wav.suffix.lower() != ".wav":
            raise ValueError(f"输出文件必须是 .wav: {output_wav}")
        if not isinstance(self.sample_rate, int) or self.sample_rate <= 0:
            raise ValueError(f"非法采样率: {self.sample_rate}")
        if shutil.which("ffmpeg") is None:
            raise RuntimeError("未找到 ffmpeg，请先安装并加入 PATH")

        output_wav.parent.mkdir(parents=True, exist_ok=True) # parents=True: 创建所有必要的父目录

        # 音频处理(降噪、响度归一化)
        filters: list[str] = []
        if self.denoise:
            filters.append("afftdn")
        if self.loudnorm:
            filters.append("loudnorm")

        # 先写临时文件，成功后再替换，避免失败留下半成品
        tmp_wav = output_wav.with_name(f"{output_wav.stem}.tmp{output_wav.suffix}")

        cmd = [
            "ffmpeg",
            "-hide_banner", # 隐藏横幅
            "-nostdin", # 不读取标准输入，避免阻塞
            "-loglevel", "error", # 错误级别
            "-y", # 覆盖输出文件
            "-i", str(video_path), # 输入文件
            "-vn", # 不提取视频流，只提取音频流
            "-ac", "1", # 音频通道数
            "-ar", str(self.sample_rate), # 音频采样率
        ]

        if filters:
            cmd += ["-af", ",".join(filters)]

        cmd += [
            "-c:a", "pcm_s16le", # 输出音频编码格式
            "-f", "wav", # 输出文件格式
            "-rf64", "auto", # 输出文件格式，当处理长音频时，使用 rf64 格式可以避免音频失真
            str(tmp_wav), # 输出文件路径
        ]

        try:
            subprocess.run(
                cmd,
                check=True, 
                capture_output=True, # 捕获标准输出和标准错误
                text=True, # 将标准输出和标准错误转换为文本
                timeout=3600,
            )
            tmp_wav.replace(output_wav) # 将临时文件替换为输出文件
        except subprocess.CalledProcessError as e:
            tmp_wav.unlink(missing_ok=True) # 删除临时文件
            raise RuntimeError(f"ffmpeg 提取音频失败: {e.stderr}") from e
        except subprocess.TimeoutExpired as e:
            tmp_wav.unlink(missing_ok=True)
            raise RuntimeError(f"ffmpeg 提取音频超时: {video_path}") from e

        return output_wav

    def detect_speech(self, wav_path: Path) -> list[SpeechSegment]:
        """使用 Silero VAD 进行语音活动检测并分割长语音段"""

        from silero_vad import get_speech_timestamps

        # 处理前检查
        if self.sample_rate not in (8000, 16000): # Silero VAD 只支持 8000 或 16000 Hz
            raise ValueError(f"Silero VAD 只支持 8000 或 16000 Hz，当前为 {self.sample_rate}")
        if not wav_path.is_file():
            raise FileNotFoundError(f"音频文件不存在: {wav_path}")

        try:
            wav, wav_sr = self._read_wav_tensor(wav_path) # 读取音频文件为 Tensor，并返回采样率
        except Exception as e:
            raise RuntimeError(f"读取音频文件失败: {wav_path}") from e

        if wav_sr != self.sample_rate: # 检查音频文件采样率是否与配置采样率一致
            raise ValueError(f"音频文件采样率 {wav_sr} 与配置采样率 {self.sample_rate} 不一致")

        if wav.numel() == 0: # 检查音频文件是否为空
            logger.info(f"VAD {wav_path.name}: audio=0.0s, segments=0, speech=0.0s, elapsed=0.0s")
            return []

        duration_sec = wav.shape[-1] / self.sample_rate # 计算音频文件时长
        if duration_sec < self.min_speech_sec: # 检查音频文件时长是否小于最小语音时长
            logger.info(f"VAD {wav_path.name}: audio={duration_sec:.1f}s (< min_speech), segments=0, speech=0.0s, elapsed=0.0s")
            return []

        # 多进程并发时限制线程，避免 CPU 过订阅
        _apply_vad_thread_tuning(
            self.torch_num_threads,
            self.onnx_intra_op_num_threads,
        )
        model = _load_vad_model() # 加载 Silero VAD 模型

        t0 = time.perf_counter()
        timestamps = get_speech_timestamps( # 获取语音活动时间戳
            wav, # 音频信号
            model, # Silero VAD 模型
            sampling_rate=self.sample_rate, # 音频采样率
            threshold=self.vad_threshold, # 语音活动检测阈值
            min_speech_duration_ms=round(self.min_speech_sec * 1000), # 最小语音时长
            min_silence_duration_ms=round(self.min_silence_sec * 1000), # 最小静默时长
            return_seconds=True, # 返回时间戳为秒
        )
        vad_elapsed = time.perf_counter() - t0 # 计算语音活动检测时间

        segments = [SpeechSegment(start_sec=float(ts["start"]), end_sec=float(ts["end"])) for ts in timestamps] # 将时间戳转换为语音段
        segments = self._split_long_segments(segments, overlap_sec=self.vad_split_overlap_sec) # 分割长语音段
        speech_sec = sum(s.duration_sec for s in segments) # 计算语音时长
        logger.info(
            "VAD %s: audio=%.1fs, segments=%d, speech=%.1fs (%.0f%%), elapsed=%.2fs",
            wav_path.name,
            duration_sec, # 音频文件时长
            len(segments), # 语音段数量
            speech_sec, # 语音时长
            (100.0 * speech_sec / duration_sec) if duration_sec > 0 else 0.0, # 语音占比
            vad_elapsed, # 语音活动检测时间
        )
        return segments

    @staticmethod
    def _read_wav_tensor(wav_path: Path):
        """读取单声道 WAV 为 float32 Tensor，并返回采样率。"""

        with wave.open(str(wav_path), "rb") as wf:
            # 处理前检查(音频文件是否为未压缩 PCM WAV)
            if wf.getcomptype() != "NONE":
                raise ValueError("仅支持未压缩 PCM WAV")
            if wf.getsampwidth() != 2:
                raise ValueError(f"仅支持 16-bit PCM，当前 {wf.getsampwidth() * 8}-bit")
            
            nchannels = wf.getnchannels() # 音频通道数
            framerate = wf.getframerate() # 音频采样率
            frames = wf.readframes(wf.getnframes()) # 读取音频帧

        audio = np.frombuffer(frames, dtype=np.int16).astype("float32") / 32768.0 # 将音频帧转换为 float32 Tensor

        # 如果音频通道数大于1，则取平均值，转换为单声道
        if nchannels > 1:
            audio = audio.reshape(-1, nchannels).mean(axis=1)

        return torch.from_numpy(audio).float(), framerate

    def _split_long_segments(self, segments: list[SpeechSegment], overlap_sec: float = 0.5) -> list[SpeechSegment]:
        """分割长语音段"""

        result: list[SpeechSegment] = []
        for seg in segments:
            if seg.duration_sec <= self.max_segment_sec:
                result.append(seg)
                continue # 继续处理下一个语音段

            # 根据最大段长分割语音段
            cursor = seg.start_sec
            while cursor < seg.end_sec:
                end = min(cursor + self.max_segment_sec, seg.end_sec)
                result.append(SpeechSegment(start_sec=cursor, end_sec=end))
                if end >= seg.end_sec:
                    break
                cursor = max(end - overlap_sec, cursor + 0.1)
        return result

    def cut_segment(self, wav_path: Path, seg: SpeechSegment, output_path: Path) -> Path:
        """按时间切分音频文件"""

        # 处理前检查
        if wav_path.resolve() == output_path.resolve():
            raise ValueError("输入和输出路径不能相同")

        output_path.parent.mkdir(parents=True, exist_ok=True)

        with wave.open(str(wav_path), "rb") as src:
            params = src.getparams() # 获取音频参数
            framerate = src.getframerate() # 获取音频采样率
            total_frames = src.getnframes() # 获取音频帧数

            start_frame = max(round(seg.start_sec * framerate), 0) # 计算起始帧
            end_frame = min(round(seg.end_sec * framerate), total_frames) # 计算结束帧

            if end_frame <= start_frame: # 检查结束帧是否小于起始帧
                raise ValueError(f"无效的语音段范围: {seg.start_sec}-{seg.end_sec}s")

            src.setpos(start_frame) # 设置起始帧
            frames = src.readframes(end_frame - start_frame) # 读取音频帧

        with wave.open(str(output_path), "wb") as dst:
            dst.setparams(params) # 设置音频参数
            dst.writeframes(frames) # 写入音频帧

        return output_path
