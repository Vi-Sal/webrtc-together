# Repository Guidelines

## Project Structure & Module Organization

This is a single-module Java 21 Spring Boot application built with Gradle. Web MVC and WebSocket dependencies are configured; it serves the Together 2.0 frontend (calls, live chat, collaborative whiteboard), `/ws/rooms` realtime messaging, `/api/call-config`, and the original `GET /greeting` endpoint. See `docs/TOGETHER-2.0.md` for the protocol and design system.

- `src/main/java/com/saldev/webrtc/`: application entry point and Java sources. Keep HTTP handlers in `controller`, WebSocket transport and room state in `realtime`, business rules (chat, whiteboard validation) in `service`, and data objects in `model`.
- `src/main/resources/application.properties`: application configuration. The plain HTML/CSS/ES-module frontend lives in `src/main/resources/static/` (`css/` tokens and per-screen styles, `js/core`, `js/components`, `js/whiteboard`); no frontend build step is required. Use design tokens from `css/tokens.css` instead of hard-coded colors, and render user text with `textContent` only.
- `src/test/java/com/saldev/webrtc/`: tests, mirroring the production package structure. `src/test/js/` holds Node unit tests for DOM-free frontend modules (`node --test src/test/js/*.test.mjs`).
- `build.gradle`, `settings.gradle`, and `gradle/wrapper/`: build configuration and pinned Gradle wrapper.
- `build/`: generated classes, artifacts, and reports; do not edit or commit generated output.

## Build, Test, and Development Commands

Use the checked-in wrapper from the repository root with JDK 21 available. On Windows, substitute `gradlew.bat` for `./gradlew`.

- `./gradlew bootRun`: start the application locally.
- `./gradlew test`: run the test suite through JUnit Platform.
- `./gradlew build`: compile, test, and produce application artifacts in `build/libs/`.
- `./gradlew clean build`: rebuild from a clean output directory.
- `./gradlew test --tests com.saldev.webrtc.WebrtcApplicationTests`: run the existing context-load test class.

Use `./gradlew bootRun --args='--server.port=8081'` if port 8080 is occupied. See `README.md` for the optional Playwright browser test, local media testing, and deployment constraints.

## Coding Style & Naming Conventions

Use four-space indentation for new controller, service, and model code. Preserve existing tabs in generated bootstrap, test, and Gradle files when editing them. No formatter or lint plugin is configured.

Use lowercase package names, PascalCase classes, and camelCase methods and fields. Follow role-based names such as `GreetingController`, `GreetingService`, and `GreetingResponse`. Prefer constructor injection, keep controllers focused on HTTP handling, and follow existing Lombok usage for response objects.

## Testing Guidelines

Tests use JUnit Jupiter and Spring Boot test support. Name test classes `*Tests` and use descriptive test methods. Use focused unit tests for service behavior and Spring integration tests where application wiring matters. The existing `@SpringBootTest` verifies context startup; no coverage threshold is configured. Run `./gradlew test` before submitting changes.

## Commit & Pull Request Guidelines

Git history is unavailable in this checkout, so no established commit convention can be verified. Use concise, imperative subjects such as `Add greeting endpoint tests`. Keep commits focused.

Pull requests should explain the change, link relevant issues, and report validation commands and results. For API changes, include example requests and responses. Keep secrets out of committed configuration; supply sensitive values through environment variables or external configuration.
