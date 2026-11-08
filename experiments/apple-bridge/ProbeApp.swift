import UIKit

// A separately signed laboratory app. None of these views or permissions are
// linked into iPortal, its watcher, or the automation helper.
@main final class ProbeApp: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let tabs = UITabBarController()
        let input = InputProbeController()
        input.tabBarItem = UITabBarItem(title: "Input", image: UIImage(systemName: "hand.draw"), tag: 0)
        let capture = CaptureProbeController()
        capture.tabBarItem = UITabBarItem(title: "Capture", image: UIImage(systemName: "record.circle"), tag: 1)
        tabs.viewControllers = [input, capture]
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = tabs
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
