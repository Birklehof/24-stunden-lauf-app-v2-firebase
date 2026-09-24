import {logger} from "firebase-functions";
import {CallableRequest, HttpsError, onCall} from "firebase-functions/v2/https";
import {initializeApp} from "firebase-admin/app";
import {getFirestore, Timestamp} from "firebase-admin/firestore";

initializeApp();

const firestore = getFirestore();

/**
 * Ensures that the caller is authenticated and has the required role.
 *
 * @param {CallableRequest} request - The callable function request.
 * @param {string} role - The required Firebase Auth custom claim role.
 * @throws {HttpsError} If the caller is not authenticated
 *                      or lacks the required role.
 */
function requireRole(request: CallableRequest, role: string): void {
  if (!request.auth) {
    throw new HttpsError(
      "unauthenticated",
      "Authentifizierung erforderlich."
    );
  }

  if (request.auth.token.role !== role) {
    throw new HttpsError(
      "permission-denied",
      "Zugriff verweigert."
    );
  }
}

/**
 * Validates that a value is a positive integer.
 *
 * @param {unknown} value - The value to validate.
 * @param {string} field - The name of the field being validated.
 * @return {number} The validated positive integer.
 * @throws {HttpsError} If the value is not a positive integer.
 */
function requirePositiveInteger(
  value: unknown,
  field: string
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new HttpsError(
      "invalid-argument",
      `Ungültiger Wert für Feld '${field}'.`
    );
  }

  return value;
}

/**
 * Validates that a value is a string.
 *
 * @param {unknown} value - The value to validate.
 * @param {string} field - The name of the field being validated.
 * @return {string} The validated string
 * @throws {HttpsError} If the value is not a string.
 */
function requireString(
  value: unknown,
  field: string
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    throw new HttpsError(
      "invalid-argument",
      `Ungültiger Wert für Feld '${field}'.`
    );
  }

  return value.trim();
}


export const createLap = onCall(
  {
    region: "europe-west3",
    minInstances: 5, // FIXME: Set back to 0 after event
    maxInstances: 10,
  },
  async (request) => {
    requireRole(request, "assistant");

    // Ensure the request contains the 'numer' field with a positive integer
    const number = requirePositiveInteger(request.data.number, "Startnummer");

    const runnerQuery = await firestore
      .collection("runners")
      .where("number", "==", number)
      .limit(1)
      .get();

    if (runnerQuery.empty) {
      throw new HttpsError("not-found", "Läufer nicht gefunden.");
    }

    const runnerRef = runnerQuery.docs[0].ref;

    try {
      const newLap = await firestore.runTransaction(async (transaction) => {
        // Check if there is a runner with the specified number
        const runnerDoc = await transaction.get(runnerRef);
        const runnerData = runnerDoc.data();
        if (!runnerDoc.exists || !runnerData) {
          throw new HttpsError("not-found", "Läufer nicht gefunden.");
        }
        const now = Timestamp.now();

        // Check if the last lap was less than 2 minutes ago
        if (runnerData.lastLapCreatedAt &&
          request.data.ignoreCooldown !== true) {
          const elapsed =
            now.toMillis() - runnerData.lastLapCreatedAt.toMillis();

          if (elapsed < 2 * 60 * 1000) {
            throw new HttpsError(
              "failed-precondition",
              "Letzte Runde weniger als 2 Minuten her."
            );
          }
        }

        // Create a new lap
        const newLap = {
          runnerId: runnerRef.id,
          createdAt: now,
          runnerData: {
            name: runnerData.name,
            number: runnerData.number,
          },
        };

        // Add the new lap
        const newLapRef = firestore.collection("laps").doc();
        transaction.set(newLapRef, newLap);

        // Update the runner
        transaction.update(runnerRef, {
          lastLapCreatedAt: now,
          laps: (runnerData.laps || 0) + 1,
        });

        // Return the new lap
        return {
          id: newLapRef.id,
          runnerId: newLap.runnerId,
          createdAt: newLap.createdAt.toMillis(),
          runner: {
            id: runnerRef.id,
            name: runnerData.name,
            number: runnerData.number,
            laps: (runnerData.laps || 0) + 1,
          },
        };
      });

      return {
        id: newLap.id,
        runnerId: newLap.runnerId,
        createdAt: newLap.createdAt,
        runner: newLap.runner,
      };
    } catch (err) {
      if (err instanceof HttpsError) {
        throw err;
      }

      logger.error("Failed to create lap", {
        error: err,
        number: number,
      });
      throw new HttpsError("internal", "Interner Serverfehler.");
    }
  }
);

export const deleteLap = onCall(
  {
    region: "europe-west3",
    minInstances: 2, // FIXME: Set back to 0 after event
    maxInstances: 10,
  },
  async (request) => {
    requireRole(request, "assistant");

    // Ensure the request contains the 'lapId' field
    const lapId = requireString(request.data.lapId, "lapId");

    const lapRef = firestore.doc(`laps/${lapId}`);

    try {
      await firestore.runTransaction(async (transaction) => {
        const lapDoc = await transaction.get(lapRef);

        if (!lapDoc.exists) {
          throw new HttpsError("not-found", "Runde nicht gefunden.");
        }

        const lapData = lapDoc.data();
        const runnerId = lapDoc.data()?.runnerId;
        const lapCreatedAt = lapData?.createdAt;

        // If the lap data is invalid delete the lap
        if (!runnerId || !(lapCreatedAt instanceof Timestamp)) {
          transaction.delete(lapRef);
          return;
        }

        const runnerRef = firestore.doc(`runners/${runnerId}`);
        const runnerDoc = await transaction.get(runnerRef);
        const runnerData = runnerDoc.data();

        if (!runnerDoc.exists || !runnerData) {
          throw new HttpsError("not-found", "Läufer nicht gefunden.");
        }

        const isLatestLap =
          runnerData.lastLapCreatedAt instanceof Timestamp &&
          runnerData.lastLapCreatedAt.isEqual(lapCreatedAt);

        transaction.delete(lapRef);
        // Only reset lastLapCreatedAt if the deleted lap was the last lap
        transaction.update(runnerRef, {
          laps: Math.max(0, (runnerData.laps ?? 0) - 1),
          ...(isLatestLap ?
            {lastLapCreatedAt: null} :
            {}),
        });
      });
    } catch (err) {
      if (err instanceof HttpsError) {
        throw err;
      }

      logger.error("Failed to delete lap", {
        error: err,
        lapId: lapId,
      });
      throw new HttpsError("internal", "Interner Serverfehler.");
    }
  }
);

export const createRunner = onCall(
  {
    region: "europe-west3",
    maxInstances: 1,
  },
  async (request) => {
    requireRole(request, "assistant");

    // Ensure the request contains the 'name' field
    const name = requireString(request.data.name, "Name");
    const email = request.data.email as string | undefined;

    const newestRunnerRef = firestore
      .collection("runners")
      .orderBy("number", "desc")
      .limit(1);

    try {
      const newRunner = await firestore.runTransaction(async (transaction) => {
        const newestRunnerDoc = await transaction.get(newestRunnerRef);

        const newNumber = newestRunnerDoc.empty ?
          1 :
          newestRunnerDoc.docs[0].data().number + 1;

        let newRunner: {
          name: string;
          number: number;
          type: string;
          laps: number;
          email?: string;
        } = {
          name,
          number: newNumber,
          type: "guest",
          laps: 0,
        };

        if (email) {
          newRunner = {...newRunner, email};
        }

        const newRunnerRef = firestore.collection("runners").doc();
        transaction.set(newRunnerRef, newRunner);

        return newRunner;
      });

      return newRunner;
    } catch (err) {
      if (err instanceof HttpsError) {
        throw err;
      }

      logger.error("Failed to create runner", {
        error: err,
        runner: {
          name: name,
          email: email,
        },
      });
      throw new HttpsError("internal", "Interner Serverfehler.");
    }
  }
);
