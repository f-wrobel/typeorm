import {Logger} from "./Logger";
import {LoggerOptions} from "./LoggerOptions";
import {SimpleConsoleLogger} from "./SimpleConsoleLogger";
import {AdvancedConsoleLogger} from "./AdvancedConsoleLogger";
import {FileLogger} from "./FileLogger";

/**
 * Helps to create logger instances.
 */
export class LoggerFactory {

    /**
     * Creates a new logger depend on a given connection's driver.
     */
    create(logger?: "advanced-console"|"simple-console"|"file"|Logger, options?: LoggerOptions): Logger {
        if (logger instanceof Object)
            return logger as Logger;

        if (logger) {
            switch (logger) {
                case "simple-console":
                    return new SimpleConsoleLogger(options);

                case "file":
                    return new FileLogger(options);

                case "advanced-console":
                    return new AdvancedConsoleLogger(options);
            }
        }

        return new AdvancedConsoleLogger(options);
    }

}