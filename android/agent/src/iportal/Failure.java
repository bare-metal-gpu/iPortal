package iportal;

/** A command error in the helper contract's vocabulary. */
final class Failure extends Exception {
  final String code;
  /** "notExecuted" when the device was certainly not changed, otherwise "unknown". */
  final String outcome;

  Failure(String code, String message) {
    this("notExecuted", code, message);
  }

  Failure(String outcome, String code, String message) {
    super(message);
    this.code = code;
    this.outcome = outcome;
  }
}
