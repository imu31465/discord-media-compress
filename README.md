# SONIC KEEP — Video Compressor

Discord向けの動画圧縮を行う、GitHub Pages対応の静的Webアプリです。動画ファイルをサーバーへアップロードせず、ブラウザ内のFFmpeg WebAssemblyで処理します。

## 主な機能

- Discord Free / Basic / Nitro向けプリセットとカスタム上限
- MP4 / MOV / WebM / MKV など、FFmpegが読み込める動画形式
- MP4 (H.264 + AAC) へ変換
- 入力に含まれる**すべての音声ストリーム**を出力へマッピング
- 目標サイズを超えた場合は映像ビットレートを再計算して最大3回試行
- 対応ブラウザではWebCodecs + Mediabunnyを使い、H.264映像のハードウェアエンコードを優先（実際にハードウェアが使われるかはブラウザ・GPU・ドライバーに依存）
- 対応する音声コーデックは再エンコードせずコピーし、入力の全音声トラックを保持
- WebCodecs経路では出力の全音声トラック数と各トラックのデコード可能なサンプルを確認
- WebCodecs非対応・入力形式非対応・音声保持や検証に失敗した場合は、FFmpeg WebAssemblyへ自動フォールバック
- FFmpeg経路では出力後にFFprobeで音声トラック数・音声パケット数を確認し、全音声を最後までデコード検証
- ダーク / ライトテーマ、ドラッグ＆ドロップ、プレビュー、キャンセル、処理ログ

## 音声を保持する仕組み

圧縮コマンドは音声ストリームを省略せず、次の指定で全音声トラックを出力へ含めます。

```text
-map 0:v:0
-map 0:a?
-c:a aac
-b:a 160k
```

音声コーデックはAACへ再エンコードします。元音声をそのままコピーする方式ではありません。MP4との互換性を優先するためで、AAC変換による音質変化は発生します。

圧縮後は以下を検証します。

1. 入力と出力の音声トラック数が一致していること
2. 出力の各音声トラックに音声パケットが存在すること
3. 出力された全音声トラックをFFmpegでデコードできること

検証に失敗した場合は、出力ファイルをダウンロード可能にしません。入力音声のデコードに対応できない場合も、音声を削除して処理を続けずにエラーで停止します。

この検証は音声トラックとデータの存在・デコード可否を確認するものです。元動画自体が無音でないことや、音声の内容が人間に聞こえることまでは判定しません。

## 起動方法

`index.html` を `file://` で直接開くのではなく、ローカルHTTPサーバーまたはGitHub Pagesで開いてください。ES Modules、Web Worker、WebAssemblyを使用します。

### ローカルで確認

Pythonがインストールされている場合、プロジェクトのルートで実行します。

```bash
python -m http.server 8000
```

ブラウザで `http://localhost:8000` を開きます。

### GitHub Pagesへデプロイ

1. このフォルダの内容をGitHubリポジトリのルートへ配置します。
2. GitHubの **Settings → Pages** を開きます。
3. **Deploy from a branch** を選択します。
4. `main` ブランチの `/ (root)` を選択して保存します。
5. 公開されたGitHub PagesのURLへアクセスします。

ビルド工程は不要です。

## 技術構成

- HTML / CSS / Vanilla JavaScript
- `mediabunny` 1.62.1 (WebCodecs高速経路)
- `@ffmpeg/ffmpeg` 0.12.15
- `@ffmpeg/core` 0.12.10 (single-thread, 互換フォールバック)
- FFmpegのFFprobe APIによるメタデータ・出力検証

Mediabunnyはesm.shから遅延ロードします。WebCodecsはブラウザ標準APIを利用するため、FFmpeg WASMコアの初回ダウンロードを回避できます。高速経路が使えない場合に備えてFFmpeg WebAssemblyも残しており、その経路ではJSDelivrからコア（約31MB）を取得します。FFmpeg側はGitHub PagesでCOOP/COEPヘッダーを設定しない構成のためシングルスレッド版です。

## 制限・注意

- 動画本体はネットワークへ送信しませんが、FFmpeg本体の取得にはインターネット接続が必要です。
- WebAssembly版FFmpegはネイティブ版FFmpegより遅く、動画ファイルの読み込み・変換には大きなメモリを使います。特に数百MB以上の動画やスマートフォンでは、ブラウザや端末のメモリ上限により失敗する場合があります。
- FFmpegビルドに含まれないコーデックや破損ファイルは処理できません。その場合は音声を落として続行せず、エラーにします。
- 音声はAACへ再エンコードされます。完全なビット単位の無劣化コピーではありません。
- サイズ上限に収めるための再試行は最大3回です。3回で上限に届かない場合も、音声を削除せず、検証済みの結果と超過警告を表示します。
- 元ファイルが安全目標サイズ以内の場合は再エンコードせず、そのままダウンロードします。

## ライセンス

このプロジェクトのHTML / CSS / JavaScriptはMIT Licenseです。FFmpegおよびFFmpeg WebAssemblyのライセンス・ビルド条件は各 upstream プロジェクトを参照してください。

- https://github.com/ffmpegwasm/ffmpeg.wasm
- https://github.com/ffmpegwasm/ffmpeg.wasm/tree/main/packages/core
