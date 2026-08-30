export class OperationName {
  static fromRoute(pickup: string | null, delivery: string | null): string {
    const origin = this.location(pickup) || "Origen pendiente";
    const destination = this.location(delivery) || "Destino pendiente";
    return `${origin} → ${destination}`;
  }

  private static location(value: string | null): string {
    return (value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  }
}
