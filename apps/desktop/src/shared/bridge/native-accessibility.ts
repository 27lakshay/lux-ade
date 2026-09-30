export interface NativeAccessibilitySnapshot {
  highContrast: boolean | null
  reducedTransparency: boolean | null
  differentiateWithoutColor: boolean | null
}

export interface NativeAccessibilityBridge {
  getSnapshot(): Promise<NativeAccessibilitySnapshot>
  onUpdate(listener: (snapshot: NativeAccessibilitySnapshot) => void): () => void
}
