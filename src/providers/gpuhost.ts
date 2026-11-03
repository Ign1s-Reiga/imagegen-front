// A GPU machine reached over SSH, for LoRA training (an existing RunPod Pod,
// or any Linux host with an NVIDIA GPU). It does not generate images, and is
// not the RunPod serverless provider: that runs a fixed worker image.

import { DEFAULT_WORKSPACE, describeTrainingError, hostSpec, testHost, trustHost } from "@/training/api";

import type { ServiceDefinition } from "./types";

// The editor tests a connection before it is saved, so the key comes from
// the form; once saved, the Rust side reads it from the keychain itself.
const unsaved = { id: "", name: "this host" };

export const gpuhost: ServiceDefinition = {
  kind: "gpuhost",
  label: "GPU host (SSH)",
  summary: "An existing GPU machine you can SSH into, such as a RunPod Pod, for LoRA training. The app never creates, stops or deletes machines.",
  fields: [
    { key: "host", label: "Host", type: "text", placeholder: "203.0.113.7", required: true, help: "For a RunPod Pod: its public IP from Connect > SSH over exposed TCP (the ssh.runpod.io proxy does not support file transfer)." },
    { key: "port", label: "Port", type: "text", default: "22", placeholder: "22", required: true },
    { key: "user", label: "User", type: "text", default: "root", placeholder: "root", required: true },
    { key: "privateKey", label: "SSH private key", type: "secret", multiline: true, required: true, placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----", help: "The private half of a key whose public half is in the host's authorized_keys, such as an ed25519 key. Stored in your system keychain, which on Windows holds about 2.5 KB per entry: too little for a 4096-bit RSA key." },
    { key: "passphrase", label: "Key passphrase", type: "secret" },
    { key: "workspace", label: "Workspace", type: "text", default: DEFAULT_WORKSPACE, placeholder: DEFAULT_WORKSPACE, help: "Everything the app puts on the host goes in this folder: its own Python environment, the base model and the training jobs. On RunPod, keep it under /workspace so it survives a restart." },
    { key: "python", label: "Python", type: "text", default: "python3", placeholder: "python3", help: "Python 3.11 or newer on the host, used to create the isolated training environment. ComfyUI's environment is never changed." },
    { key: "loraDir", label: "ComfyUI LoRA folder", type: "text", placeholder: "/workspace/ComfyUI/models/loras", help: "Where to install trained LoRAs for a ComfyUI running on this host. Leave empty if it has none." },
    { key: "hfToken", label: "Hugging Face token", type: "secret", help: "Only needed if the base model download asks for one. Sent to the host only for the download, never written to its disk." },
    { key: "hourlyPrice", label: "Price per hour (USD)", type: "text", placeholder: "0.79", help: "Optional. With it, cost is estimated from the measured training pace." },
  ],
  async testConnection(config) {
    try {
      const info = await testHost(hostSpec(unsaved, config, true));
      return `Connected. Runner ${info.runnerVersion} is installed in the workspace. Check the GPU and environment from the Training page.`;
    } catch (err) {
      throw new Error(describeTrainingError(err), { cause: err });
    }
  },
  trustHostKey: (config, fingerprint) => trustHost(hostSpec(unsaved, config, true), fingerprint),
};
