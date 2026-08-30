export type OperationStatus =
  | "Sourcing"
  | "Quotes received"
  | "Booking pending"
  | "Booking confirmed"
  | "Needs follow-up";

export type Operation = {
  reference: string;
  client: string;
  container: string;
  containerType: string;
  weight: string;
  origin: string;
  destination: string;
  emptyReturn: string;
  status: OperationStatus;
  nextStep: string;
  updated: string;
  isEscalated?: boolean;
};

export const operations: Operation[] = [
  {
    reference: "OP-900024",
    client: "Textiles del Plata",
    container: "MSKU 482019-6",
    containerType: "40' Dry",
    weight: "24,000 kg",
    origin: "Terminal 4, Buenos Aires",
    destination: "González Catán, Buenos Aires",
    emptyReturn: "Dock Sud empty depot",
    status: "Needs follow-up",
    nextStep: "Review live reschedule request",
    updated: "2 min ago",
    isEscalated: true,
  },
  {
    reference: "OP-900021",
    client: "Río Norte Imports",
    container: "TCLU 613804-2",
    containerType: "40' HC",
    weight: "21,600 kg",
    origin: "Exolgan Terminal",
    destination: "Pilar, Buenos Aires",
    emptyReturn: "Zárate empty depot",
    status: "Booking pending",
    nextStep: "Await provider confirmation",
    updated: "8 min ago",
  },
  {
    reference: "OP-900018",
    client: "Andes Paper Co.",
    container: "FSCU 721903-8",
    containerType: "20' Dry",
    weight: "16,400 kg",
    origin: "Terminal 4, Buenos Aires",
    destination: "Tigre, Buenos Aires",
    emptyReturn: "Dock Sud empty depot",
    status: "Quotes received",
    nextStep: "Select compliant quote",
    updated: "17 min ago",
  },
  {
    reference: "OP-900015",
    client: "Casa Brava",
    container: "OOLU 384205-1",
    containerType: "40' Dry",
    weight: "22,900 kg",
    origin: "TRP Terminal",
    destination: "San Martín, Buenos Aires",
    emptyReturn: "Avellaneda empty depot",
    status: "Sourcing",
    nextStep: "2 providers being contacted",
    updated: "24 min ago",
  },
  {
    reference: "OP-900011",
    client: "Litoral Foods",
    container: "CAIU 948201-7",
    containerType: "40' HC",
    weight: "19,750 kg",
    origin: "Terminal 4, Buenos Aires",
    destination: "Moreno, Buenos Aires",
    emptyReturn: "Dock Sud empty depot",
    status: "Booking confirmed",
    nextStep: "Pickup window opens at 14:00",
    updated: "32 min ago",
  },
  {
    reference: "OP-900008",
    client: "Pampero Home",
    container: "SEGU 105729-4",
    containerType: "20' Dry",
    weight: "12,200 kg",
    origin: "Exolgan Terminal",
    destination: "Quilmes, Buenos Aires",
    emptyReturn: "Zárate empty depot",
    status: "Sourcing",
    nextStep: "Quote request sent to 3 providers",
    updated: "41 min ago",
  },
];

export const escalatedOperation = operations[0];

// Planned API boundary. Keep mock data as the rendering source until Express exposes
// GET /api/dashboard/operations; then replace the line below with the commented fetch.
export async function getOpenOperations(): Promise<Operation[]> {
  // const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/dashboard/operations`, {
  //   headers: { Authorization: `Bearer ${accessToken}` },
  //   cache: "no-store",
  // });
  // if (!response.ok) throw new Error("Unable to load operations.");
  // return response.json() as Promise<Operation[]>;
  return operations;
}

export async function getOperation(reference: string): Promise<Operation | undefined> {
  // const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/dashboard/operations/${reference}`, {
  //   headers: { Authorization: `Bearer ${accessToken}` },
  //   cache: "no-store",
  // });
  // if (!response.ok) throw new Error("Unable to load operation.");
  // return response.json() as Promise<Operation>;
  return operations.find((operation) => operation.reference === reference);
}
